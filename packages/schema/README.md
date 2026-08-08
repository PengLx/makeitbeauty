# @makeitbeauty/schema

Source-of-truth JSON Schemas (draft 2020-12) shared by all services.

| File | Contract |
|---|---|
| `design.schema.json` | The design document users create in the editor |
| `project.schema.json` | An image project: design + connector bindings + outputs |
| `connector-manifest.schema.json` | Connector declaration (auth tier, snapshot shape, TTL) |
| `render.schema.json` | Internal `api → renderer` render request/response |

Consumers: `apps/renderer` validates with ajv; `apps/api` mirrors these shapes as
Go structs (codegen planned; keep in sync by hand until then). The canonical
fixtures in `examples/` must always validate against these schemas.
