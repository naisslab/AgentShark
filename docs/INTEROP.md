# Offline Telemetry Interoperability

AgentShark can export selected indexed spans as OTLP/JSON with OpenInference attributes. It can also convert an OTLP/JSON file into a portable AgentShark telemetry document. Both operations work on local JSON; they do not start a collector or contact a telemetry service.

Import currently produces `agentshark.telemetry.v1`, a conversion document. It does **not** insert arbitrary telemetry into the native coding-agent index. Generic telemetry may lack a supported coding-agent identity or timestamps required by that index. The converter preserves those values as unknown instead of assigning a provider or creating timestamps.

## Supported Input

The input is an OTLP trace export request containing `resourceSpans`, `scopeSpans`, and `spans`. A recognized AgentShark export envelope is also accepted, so CLI exports can be converted directly. The original envelope is preserved as `sourceEnvelope`; its coverage claims are retained as unverified metadata. Each span needs a valid trace ID and span ID. Uppercase and lowercase hex IDs are accepted. Resource attributes, instrumentation scope, span attributes, span events, links, and unknown fields remain available in `nativeDocument` and each span's `native` record.

The converter accepts protobuf `AnyValue` strings, booleans, integers, finite doubles, arrays, key-value lists, and base64 byte values. It rejects duplicate attribute keys, duplicate span identities, excessive nesting, unsafe numeric timestamps, and oversized inputs. Limits default to 10,000 spans and 20 MiB of serialized input. The span limit can increase to 50,000.

This converter follows a bounded subset of OTLP/JSON. It does not implement protobuf transport, live collection, metrics, logs, or profiles. Keeping a native field does not imply that AgentShark interprets it.

## Field Mapping

| Input | Portable Record | Missing or Unsupported Data |
| --- | --- | --- |
| `traceId`, `spanId` | Stable `otlp:<trace>:<span>` identity | Invalid or all-zero IDs are rejected |
| `parentSpanId` | Recorded parent ID | A parent outside the document becomes a coverage gap |
| `startTimeUnixNano`, `endTimeUnixNano` | Integer microsecond times | Missing times remain `null`; inverted end times have no usable duration |
| `status.code` | `ok`, `error`, or `unknown` | Unset status remains unknown |
| `openinference.span.kind=LLM` | `kind: llm` | Other unmapped kinds remain unknown |
| `TOOL`, `AGENT`, `CHAIN` | `tool`, `agent`, `workflow` | Original values remain preserved |
| `llm.model_name` | `model` | Unknown if absent |
| `llm.token_count.prompt` | `inputTokens` | Missing counts remain `null` |
| `llm.token_count.completion` | `outputTokens` | Missing counts remain `null` |

The converter also recognizes recorded `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, and `gen_ai.usage.output_tokens` as fallback attribute names. These aliases do not establish semantic equivalence across instrumentation versions. The original attribute names and values remain inspectable.

Nanosecond timestamps use decimal strings. The converter accepts numeric values only when JavaScript can represent the integer exactly. Sub-microsecond precision is rounded down and disclosed in coverage. Raw nanosecond strings remain in the native record.

## Export Behavior

Export generates deterministic hexadecimal trace and span IDs and records the original AgentShark identifiers in attributes. The document uses decimal strings for nanosecond timestamps and integer enum values. Those encodings follow the [OTLP JSON specification](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding).

OpenInference model and token attributes follow the [OpenInference semantic conventions](https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md). Prompt token counts include cache tokens under that convention; the exporter copies AgentShark's recorded input count and does not add cache counts again.

Only spans with known start and end times are exported. Every omitted span appears in `omittedSpans`. Events without an exported span or logged timestamp contribute to `unexportedEventCount`. Span containment remains a parent relationship; it does not become an inferred execution dependency.

Text is omitted by default. `includeText` includes span names, indexed summaries, and normalized attributes. Default exports still contain identifiers and measurement metadata. This option controls text inclusion and is not a general privacy guarantee. Use the structural dataset or shareable capture export when stronger omission is needed.

## Programmatic Use

```ts
import { createWorkbench, importTelemetryDocument } from '../src/workbench/index.ts';

const workbench = createWorkbench(readOnlyDatabase);
const exported = workbench.exportTelemetry({ sessions: ['cx:example'] });
// Save exported.document as an OTLP/JSON file.

const converted = importTelemetryDocument(parsedOtlpJson);
// Save or inspect converted; this call does not modify a database.
```

The public methods are synchronous. Indexed exports use a consistent read snapshot and honor `allowedSessions` when the host supplies a project scope. A raw conversion has no database access.

## Research Contracts

Machine-readable contracts live under `src/workbench/schemas`:

- `manifest.schema.json`: task, condition, trial, outcome, and split metadata.
- `annotation.schema.json`: reviewed judgments with author, rubric version, and event references.
- `recipe.schema.json`: saved Workbench operation and input, including an ordered sequence-search request. The sequence request has a reusable schema definition for repetition, bounded gaps, and time windows.
- `investigation.schema.json`: a saved investigation document with corpus identity, findings, annotations, and coverage.

Runtime validation also checks database membership, project scope, duplicate task/condition/trial keys, and evidence references. JSON Schema alone cannot establish these relationships. Sequence recipes operate within each session; they never join unrelated sessions into a match.

Conformance tests are in `test/workbench/interop.test.ts`. They cover ID encoding, nanosecond precision, missing data, OpenInference mappings, native-record retention, scope isolation, and a timing round trip. These tests cover the supported mapping, not every possible OTLP field.
