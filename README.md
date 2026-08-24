# dsh-session-id

A small DeepSeek Harness web client plugin that appends each ordinary session's
eight-character ID to its sidebar title, for example `cur1 (7e13b62c)`. Click
the parenthesized ID to copy the complete session ID.

The short form removes DSH's internal `session-` prefix and matches the ID form
used by the Qiyue QQ connector.

## Development

```sh
pnpm install
pnpm test
```

Install it into a profile with:

```sh
dsh plugin --profile web add file:/home/rivers/projects/dsh-session-id
```
