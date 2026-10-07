# Channel proxy

Dependency-free Node HTTP/SSE service. It serves the browser UI and redistributes
digital/numeric channel blocks independently of the ESP32 acquisition network.

```sh
node proxy/server.mjs --bind 127.0.0.1 --port 8903
```

Open `http://127.0.0.1:8903/`. Expand **Share / subscribe through channel proxy**,
choose original, processed or both, and publish the current local channels.
Another app/browser can read snapshots or subscribe. Publishing is explicit;
subsequent local edits require another publish. Subscription does not automatically
republish received data, preventing accidental feedback loops.

## Routes

| Method / path | Behavior |
|---|---|
| `GET /api/health` | Service version, current revision and channel count |
| `POST /api/channels` | Validate and atomically publish `{channels:[{id,raw?,processed?}]}` |
| `PUT /api/channels/:id` | Publish/update one record's supplied branches |
| `GET /api/channels` | Latest records; optional `branch=raw|processed|both` and `ids=id1,id2` |
| `GET /api/channels/:id` | Latest selected branches of one record |
| `GET /api/events` | SSE snapshot-reset marker, current channel messages, subsequent updates/removals |
| `DELETE /api/channels/:id` | Remove a record and notify subscribers |

Each branch is a version-1 digital/numeric channel envelope from
`docs/channel-lab.md`. The proxy validates but does **not normalize, compact,
filter or reinterpret** received branch data. Browser-published originals keep
every source observation; processed exports may compact redundant states.
Here `raw` means **as received**, not necessarily physically unprocessed: the
envelope's `stage` and provenance remain authoritative.

Records carry `revision`, `updatedAt`, `rawRevision` and `processedRevision`.
Updating one branch retains the other with its earlier branch revision; clients
must not assume the pair represents simultaneous or mutually consistent captures.
Publishing both in one request gives both the same revision. Revisions are local
to the current proxy process and reset on restart.

Example publisher:

```sh
curl -X PUT http://127.0.0.1:8903/api/channels/door \
  -H 'Content-Type: application/json' \
  --data '{"raw":{"schemaVersion":1,"name":"Door","kind":"digital","stage":"raw","data":{"encoding":"bits","intervalUs":1000,"values":"001?10"}}}'
```

Consumers:

```sh
curl 'http://127.0.0.1:8903/api/channels/door?branch=raw'
curl -N 'http://127.0.0.1:8903/api/events?branch=both&ids=door'
```

SSE clients reconnect to a fresh snapshot. A `snapshot` event resets subscribed
state and is followed by individual `channel` messages. This is a **latest-block
proxy**, not durable recording, sample-history replay, guaranteed lossless streaming
or an ESP32 command relay. Slow subscribers are disconnected when their output
buffer exceeds the budget. Limits: 8 MB request, 64 records, 64 MB retained JSON,
16 subscribers; every branch also observes the channel adapter's point limit.

## Another network / tunnel

Acquisition and redistribution endpoints are separate:

```text
ESP32 -- acquisition adapter (USB / ESP32-facing network) --> lab host
file/session/other publisher -------------------------------> proxy on lab host
                                                             |
                                other app/browser <--- HTTP / SSE / SSH tunnel
```

The service binds loopback by default and contains no HTTP authentication or
hardware-command forwarding. For access from another machine through SSH:

```sh
ssh -N -L 18903:127.0.0.1:8903 user@lab-host
```

Then open `http://127.0.0.1:18903/` locally. The UI uses its serving origin as the
proxy URL, so a forwarded port works without assuming the ESP32's subnet.
`--bind` can select another host interface; authorization/TLS for a publicly
reachable service would be supplied by a deployment/reverse-proxy layer.
This task did not establish a remote tunnel or change host routing.

Audio, image and high-rate live-capture codecs are not implemented in this proxy
version. Their future adapters should preserve declared units, clocks, gaps,
configuration revisions and backpressure rather than disguising them as bit strings.

## Checks

```sh
npm --prefix proxy test
npm --prefix proxy run check
```

Tests exercise exact original preservation, independent raw/processed readers,
atomic rejection of bad batches, mixed-age branch revisions, SSE updates and removal.
