# Troubleshooting

| Symptom | Check |
| --- | --- |
| Tools list works but calls say `not_configured` | Provision `NS_API_KEY` in local `.dev.vars` or Worker secrets |
| HTTP 503 before a tool runs | Confirm the Durable Object binding and its availability |
| HTTP 429 | Respect `Retry-After`; discovery calls do not consume the tool-call allowance |
| `invalid_response` | The provider payload did not match a supported shape; inspect a sanitized fixture and update its parser/test |
| `needs_clarification` | Choose one returned station and repeat the request with its name/code |
| Package refuses an endpoint | Verify HTTPS, endpoint identity and the exact MVP three-tool catalog |
| ChatGPT does not select the plugin | Confirm installation/tools first, then record an untagged routing case; connectivity alone does not prove discovery |

Report the package version, timestamp, operation and safe error category. Do not
include API keys, raw travel requests or full provider responses in public issues.
