# Gotchas and Prohibited Shortcuts

These restrictions are architectural, not stylistic preferences.

| Shortcut                                              | Why prohibited                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| Scaffold a new Electron app or desktop shell          | The host already exists; extend current lifecycle and contracts               |
| Add a parallel preload or global store                | Duplicates application infrastructure and creates competing ownership         |
| Reorganize unrelated desktop code while adding AI     | Expands blast radius and obscures feature regressions                         |
| Spawn one process per request                         | Adds startup latency and weakens lifecycle control                            |
| Expose generic IPC or native invocation               | Creates an arbitrary native capability surface                                |
| Run concurrent model sessions in v1                   | Adds race, memory, ordering, and stale-overwrite hazards                      |
| Keep a day-long model transcript                      | Consumes context and creates hidden state drift                               |
| Ask the model to discover all levels from raw candles | Wastes context and lowers reliability; supply deterministic candidates        |
| Parse prose into actions                              | Brittle and unsafe; consume constrained structured output                     |
| Trim context silently                                 | Produces false confidence; declare omissions and downgrade tasks              |
| Use cumulative candle deltas                          | Forces long arithmetic reconstruction and compounds mistakes                  |
| Log on sidecar stdout                                 | Corrupts NDJSON framing                                                       |
| Treat TypeScript types as validation                  | Types do not exist at runtime                                                 |
| Pass `process.env` wholesale                          | Leaks credentials and unrelated secrets                                       |
| Promote every completed result                        | Allows stale candle or position results to overwrite current guidance         |
| Import order execution into AI modules                | Violates the advisory-only boundary                                           |
| Copy architecture into task prompts                   | Causes documentation drift; link to canonical files                           |
| Introduce XPC immediately                             | Adds signing and entitlement complexity without measured need                 |
| Implement automatic triggers in bridge PR             | Combines lifecycle risk with product behavior before the foundation is proven |
| Resolve native binary through PATH                    | Permits unexpected or tampered executable selection                           |
| Treat unavailability as a crash                       | Causes restart loops on unsupported or disabled systems                       |
| Hide omitted position/risk data                       | Allows trade-management advice without required evidence                      |
| Accept generated numeric levels                       | Ungrounded values must be rejected or downgraded                              |

## Boundary questions requiring an ADR amendment

Stop implementation and propose an ADR amendment when a task requires:

- XPC or a transport other than stdio;
- more than one concurrent inference;
- persistent cross-request model sessions;
- native network, keychain, shell, arbitrary file, or plugin capability;
- model tool calls into application services;
- AI-generated executable order data;
- process ownership outside Electron main;
- cloud fallback as part of the same runtime contract.
