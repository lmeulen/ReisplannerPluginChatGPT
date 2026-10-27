# Data handling

The Worker sends the requested station codes, travel time, language and relevant
planning flags to NS over HTTPS. The upstream subscription key is a server-side
secret. It is not accepted as tool input or returned in responses.

The application stores no journey history or travel-response cache. Its Durable
Object stores a request count and reset time for an IP-derived bucket. Requests
without Cloudflare's client-IP header share a conservative bucket. This limit
state is operational data, not a user account or travel history.

Application logs record operation, outcome and duration. Debug logs add a random
request ID, canonical route, HTTP method/status and duration. They omit raw
requests, station queries, credentials and journey references. Cloudflare, NS
and the chat host have independent infrastructure logs and retention policies;
this source alone does not establish their complete retention behavior.

The plugin is read-only and does not book or reserve anything. Results are
snapshots, and failures or empty lists do not establish that no service exists.
