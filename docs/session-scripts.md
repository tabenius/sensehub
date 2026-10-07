# Sessions and command scripts

**Save session** downloads a version-1 JSON file containing digital/numeric
original observations, stable channel IDs, effective processing settings and
visibility/original-trace preferences. **Open session / script** merges a session
into the current bench; conflicting IDs or a channel-limit overflow are rejected
before importing, retaining existing channels.

Audio source files and plot preferences are not embedded in this session version.
For an individual processed result use **Export processed** instead.

The command console is a small declarative DSL, not JavaScript execution or a
shell. Ctrl+K focuses it; Ctrl+Enter validates and runs its contents. Supported:

```text
help
list
add <JSON channel envelope with an explicit id>
process <id> {"debounceUs":2000}
show <id>
hide <id>
remove <id>
```

Blank lines and full-line `#` comments are ignored. JSON may contain spaces but
each command occupies one line. File scripts use the `.sensehub` extension;
see `ui/examples/optical-bench.sensehub`. A session JSON stores the resulting
bench, while a script states how to construct/modify it. Both preserve original
observations rather than saving only a cleaned trace.

Every script is checked against a simulated channel map before applying any
command. Invalid IDs, unsupported processing keys, bad thresholds or timing,
duplicate additions and limit violations produce an error. Scripts cannot send
hardware commands, open windows, execute code or publish to the network.

Processing options: `invert` and `median` booleans, `debounceUs` nonnegative
integer, `low`/`high` numeric thresholds with `low < high` for numeric channels,
and `emaAlpha` in `(0,1]`. The console and UI modify the same model and sync
visible controls. Times in recipes are µs; UI debounce fields are ms.
