// Bounded request/response helper. libproc includes every thread in each process's counters.
// No process names, arguments or environment cross this pipe.
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <mach/mach_time.h>
#include <util.h>
#include <poll.h>
#include <signal.h>
#include <sys/wait.h>
#include <errno.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <sys/sysctl.h>
#include <sys/socket.h>
#include <net/if.h>
#include <net/if_mib.h>
#define LIMIT 128
struct tracked { int pid; uint64_t start; int root; int rejected; unsigned int parent; };
static struct tracked known[LIMIT];
static int count, last_truncated;
static int add(int pid, int root) {
  if (pid <= 0) return 1;
  for (int i=0;i<count;i++) if (known[i].pid==pid) { known[i].root |= root; return 1; }
  if (count==LIMIT) return 0;
  known[count++]=(struct tracked){.pid=pid,.root=root}; return 1;
}
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec+t.tv_nsec/1e9; }
// Public 64-bit interface counters, queried on demand. Avoid a netstat launch
// every second, name/address resolution, and parsing a table of repeated addresses.
static int interfaces(void) {
  int mib[]={CTL_NET,PF_LINK,NETLINK_GENERIC,IFMIB_IFALLDATA,0,IFDATA_GENERAL};
  struct ifmibdata entries[512];char request[8];
  setvbuf(stdout,NULL,_IOLBF,0);
  while(fgets(request,sizeof(request),stdin)) {
    if(strcmp(request,"\n")) return 2;
    size_t length=sizeof(entries);
    if(sysctl(mib,6,entries,&length,NULL,0) || length>sizeof(entries) || length%sizeof(*entries)) return 3;
    int printed=0;printf("[");
    for(size_t i=0;i<length/sizeof(*entries);i++) {
      struct ifmibdata *entry=&entries[i];char *name=entry->ifmd_name;
      if(!(entry->ifmd_flags&IFF_LOOPBACK) && strnlen(name,IFNAMSIZ)<IFNAMSIZ
        && strspn(name,"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-")==strlen(name)) {
        printf("%s{\"name\":\"%s\",\"rxBytes\":%llu,\"txBytes\":%llu}",printed++?",":"",name,
          (unsigned long long)entry->ifmd_data.ifi_ibytes,(unsigned long long)entry->ifmd_data.ifi_obytes);
      }
    }
    printf("]\n");
  }
  return ferror(stdin)?1:0;
}
// Slow, one-shot discovery. Match writable descriptors by device + inode against
// indexed transcripts supplied on stdin. Return only source indices and lifetimes.
#define SOURCE_LIMIT 8192
struct source_identity { uint32_t dev; uint64_t ino; int index; };
static int compare_source(const void *a,const void *b) {
  const struct source_identity *x=a,*y=b;
  if(x->dev!=y->dev) return x->dev<y->dev?-1:1;
  return x->ino==y->ino?0:x->ino<y->ino?-1:1;
}
static int discover(void) {
  struct source_identity sources[SOURCE_LIMIT]; int ns=0, index=0, truncated=0, printed=0, checked=0;
  char *path=NULL; size_t capacity=0; ssize_t length;
  while((length=getdelim(&path,&capacity,'\0',stdin))>0) {
    if(index>=SOURCE_LIMIT || length>4096 || path[length-1]!='\0') { free(path);return 2; }
    struct stat s;
    if(!stat(path,&s) && S_ISREG(s.st_mode)) sources[ns++]=(struct source_identity){(uint32_t)s.st_dev,s.st_ino,index};
    index++;
  }
  free(path); if(ferror(stdin)) return 2;
  qsort(sources,ns,sizeof(*sources),compare_source);
  int pids[8192]; int n=proc_listallpids(pids,sizeof(pids));
  if(n<0) return 3;
  if(n>=8192) { n=8192;truncated=1; }
  double deadline=now()+1.5;
  printf("{\"entries\":[");
  for(int i=0;ns && i<n;i++) {
    if(now()>deadline || checked>=65536 || printed>=1024) { truncated=1;break; }
    int pid=pids[i]; struct proc_bsdinfo b={0}; struct rusage_info_v2 before={0},after={0};
    if(pid<=0 || pid==getpid() || pid==getppid()
      || proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&b,sizeof(b))!=sizeof(b) || b.pbi_uid!=getuid()
      || proc_pid_rusage(pid,RUSAGE_INFO_V2,(rusage_info_t*)&before)) continue;
    struct proc_fdinfo fds[4096]; int bytes=proc_pidinfo(pid,PROC_PIDLISTFDS,0,fds,sizeof(fds));
    if(bytes<0) continue;
    if(bytes>=(int)sizeof(fds)) { bytes=sizeof(fds);truncated=1; }
    int matches[1024], nm=0;
    for(int j=0;j<(int)(bytes/sizeof(*fds));j++) {
      if(now()>deadline || ++checked>65536 || nm>=1024) { truncated=1;break; }
      if(fds[j].proc_fdtype!=PROX_FDTYPE_VNODE) continue;
      struct vnode_fdinfo v={0};
      if(proc_pidfdinfo(pid,fds[j].proc_fd,PROC_PIDFDVNODEINFO,&v,sizeof(v))!=sizeof(v) || !(v.pfi.fi_openflags&FWRITE)) continue;
      struct source_identity key={v.pvi.vi_stat.vst_dev,v.pvi.vi_stat.vst_ino,0};
      struct source_identity *found=bsearch(&key,sources,ns,sizeof(*sources),compare_source);
      if(!found) continue;
      while(found>sources && !compare_source(found-1,&key)) found--;
      for(;found<sources+ns && !compare_source(found,&key);found++) {
        int duplicate=0;for(int k=0;k<nm;k++) if(matches[k]==found->index) duplicate=1;
        if(!duplicate && nm<1024) matches[nm++]=found->index;
      }
    }
    if(proc_pid_rusage(pid,RUSAGE_INFO_V2,(rusage_info_t*)&after) || before.ri_proc_start_abstime!=after.ri_proc_start_abstime) continue;
    for(int j=0;j<nm && printed<1024;j++) printf("%s{\"pid\":%d,\"startId\":\"%llu\",\"source\":%d}",printed++?",":"",pid,(unsigned long long)before.ri_proc_start_abstime,matches[j]);
    if(printed>=1024) truncated=1;
  }
  printf("],\"truncated\":%s}\n",truncated?"true":"false");return 0;
}
static volatile sig_atomic_t stopped;
static void stop_network(int signal_number) { (void)signal_number; stopped=1; }
static int network(int argc,char **argv) {
  if(argc<3 || argc>LIMIT+2) return 2;
  int live=!strcmp(argv[1],"--network-live");
  char *args[12+2*LIMIT]={"nettop","-P","-n","-x","-L","0","-s","1","-J","bytes_in,bytes_out"};
  int n=10,selected[LIMIT],selected_count=0;
  for(int i=2;i<argc;i++) {
    char *end; long pid=strtol(argv[i],&end,10); if(*end || pid<=0 || pid>2147483647) return 2;
    selected[selected_count++]=(int)pid;
    // nettop rejects more than 20 -p arguments. One summary sampler remains
    // cheaper than several instances; filter larger groups before emitting rows.
    if(!live && argc-2<=20) { args[n++]="-p";args[n++]=argv[i]; }
  }
  args[n]=NULL;
  int master; pid_t child=forkpty(&master,NULL,NULL,NULL);
  if(child<0) return 3;
  if(!child) { execv("/usr/bin/nettop",args); _exit(127); }
  signal(SIGTERM,stop_network);signal(SIGINT,stop_network);signal(SIGPIPE,SIG_IGN);
  // nettop block-buffers a plain pipe. A PTY makes its 1 Hz CSV frames arrive promptly.
  char line[4096],updates[2048];size_t used=0,update_used=0;
  setvbuf(stdout,NULL,_IOLBF,0);
  struct pollfd fds[2]={{master,POLLIN,0},{STDIN_FILENO,POLLIN|POLLHUP,0}};
  while(!stopped) {
    if(poll(fds,2,1000)<0) { if(errno==EINTR) continue; break; }
    if(fds[1].revents&(POLLHUP|POLLERR)) break;
    if(fds[1].revents&POLLIN) {
      if(!live) break;
      ssize_t got=read(STDIN_FILENO,updates+update_used,sizeof(updates)-1-update_used);
      if(got<=0) break;
      update_used+=got;updates[update_used]='\0';
      char *newline;
      while((newline=strchr(updates,'\n'))) {
        *newline='\0';int next[LIMIT],size=0;char *save=NULL;
        for(char *p=strtok_r(updates," ",&save);p;p=strtok_r(NULL," ",&save)) {
          char *end;long pid=strtol(p,&end,10);
          if(*end || pid<=0 || pid>2147483647 || size==LIMIT) { stopped=1;break; }
          next[size++]=(int)pid;
        }
        if(stopped) break;
        memcpy(selected,next,size*sizeof(*next));selected_count=size;
        size_t consumed=newline-updates+1;memmove(updates,updates+consumed,update_used-consumed);update_used-=consumed;updates[update_used]='\0';
      }
      if(update_used==sizeof(updates)-1) break;
    }
    if(fds[0].revents) {
      char buffer[4096];ssize_t size=read(master,buffer,sizeof(buffer));if(size<=0) break;
      for(ssize_t offset=0;offset<size;offset++) {
        if(used>=sizeof(line)-1) { stopped=1;break; }
        line[used++]=buffer[offset];if(buffer[offset]!='\n') continue;
        line[used]='\0';
        if(line[0]==',' && strstr(line,"bytes_in") && strstr(line,"bytes_out")) fputs(line,stdout);
        else {
          char *comma=strchr(line,',');
          if(comma) {
            *comma='\0';char *dot=strrchr(line,'.'),*end=NULL;
            long pid=dot?strtol(dot+1,&end,10):0;
            if(dot && end==comma) for(int j=0;j<selected_count;j++) if(selected[j]==pid) { printf("p.%ld,%s",pid,comma+1);break; }
          }
        }
        used=0;
      }
    }
  }
  close(master);kill(child,SIGKILL);while(waitpid(child,NULL,0)<0 && errno==EINTR){}return 0;
}
int main(int argc,char **argv) {
  if(argc==2 && !strcmp(argv[1],"--interfaces")) return interfaces();
  if(argc>1) return !strcmp(argv[1],"--discover")?discover():(!strcmp(argv[1],"--network") || !strcmp(argv[1],"--network-live"))?network(argc,argv):2;
  char line[1024], previous[1024]=""; double discovered=-1e30;
  mach_timebase_info_data_t timebase;
  if(mach_timebase_info(&timebase)!=KERN_SUCCESS || !timebase.denom) return 3;
  const double us_per_tick=(double)timebase.numer/timebase.denom/1000.0;
  setvbuf(stdout,NULL,_IOLBF,0);
  while (fgets(line,sizeof(line),stdin)) {
    if (!strchr(line,'\n')) return 2;
    if (strcmp(previous,line)) {
      strcpy(previous,line); count=0; discovered=-1e30;
      char *save=NULL;
      for(char *p=strtok_r(line," ,\n",&save);p;p=strtok_r(NULL," ,\n",&save)) {
        char *end; long n=strtol(p,&end,10); if(*end || n<=0 || n>2147483647) return 2;
        if(!add((int)n,1)) return 2;
      }
    }
    int discover=now()-discovered>=0.995, truncated=last_truncated, unavailable[LIMIT], nmissing=0, printed=0;
    if(discover) truncated=0;
    if(discover) discovered=now();
    printf("{\"entries\":[");
    for(int i=0;i<count;i++) {
      if(known[i].pid==getpid() || (known[i].pid==getppid() && !known[i].root)) continue;
      struct rusage_info_v2 r={0};
      if (known[i].rejected || proc_pid_rusage(known[i].pid,RUSAGE_INFO_V2,(rusage_info_t*)&r)
          || (known[i].start && known[i].start!=r.ri_proc_start_abstime)) {
        unavailable[nmissing++]=known[i].pid; if(known[i].root) known[i].rejected=1; continue;
      }
      // rusage returns counters and lifetime atomically. Refresh parent metadata
      // with child discovery at 1 Hz; only that two-call join needs revalidation.
      int refresh=discover || !known[i].start;
      if(refresh) {
        struct proc_bsdinfo b={0};
        if(proc_pidinfo(known[i].pid,PROC_PIDTBSDINFO,0,&b,sizeof(b))!=sizeof(b)) {
          unavailable[nmissing++]=known[i].pid;continue;
        }
        known[i].parent=b.pbi_ppid;
      }
      known[i].start=r.ri_proc_start_abstime;
      if(discover) {
        int children[LIMIT+1]={0}; int n=proc_listchildpids(known[i].pid,children,sizeof(children));
        if(n<0) truncated=1;
        else { if(n>LIMIT+1) n=LIMIT+1;
          if(n==LIMIT+1) truncated=1;
          for(int j=0;j<n;j++) if(children[j]!=getpid() && !add(children[j],0)) truncated=1;
        }
      }
      if(refresh) {
        struct rusage_info_v2 verified={0};
        if(proc_pid_rusage(known[i].pid,RUSAGE_INFO_V2,(rusage_info_t*)&verified)
          || verified.ri_proc_start_abstime!=r.ri_proc_start_abstime) {
          unavailable[nmissing++]=known[i].pid;continue;
        }
      }
      printf("%s{\"pid\":%d,\"parentPid\":%u,\"startId\":\"%llu\",\"cpuTimeUs\":%.3f,\"residentBytes\":%llu,\"readBytes\":%llu,\"writeBytes\":%llu}",
        printed++?",":"",known[i].pid,known[i].parent,(unsigned long long)r.ri_proc_start_abstime,
        ((double)r.ri_user_time+(double)r.ri_system_time)*us_per_tick,(unsigned long long)r.ri_resident_size,
        (unsigned long long)r.ri_diskio_bytesread,(unsigned long long)r.ri_diskio_byteswritten);
    }
    printf("],\"unavailablePids\":["); for(int i=0;i<nmissing;i++) printf("%s%d",i?",":"",unavailable[i]);
    printf("],\"truncated\":%s}\n",truncated?"true":"false");
    last_truncated=truncated;
    // Reclaim exited descendants; root lifetime rejections remain pinned.
    for(int i=count-1;i>=0;i--) if(!known[i].root) {
      for(int j=0;j<nmissing;j++) if(known[i].pid==unavailable[j]) { known[i]=known[--count]; break; }
    }
  }
  return ferror(stdin)?1:0;
}
