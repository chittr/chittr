# Terminal images

Historical run records named below are held privately under
[#99](https://github.com/mcgloneb/ai-chat/issues/99). They are not files in this
checkout or acceptance evidence for a new build. Preserve their dated results
and limitations; record new sanitized acceptance on the owning open issue.

Press **Ctrl+O** to open the attachment input. Your caption, leading recipients
and `/reply` target stay in the message composer. Enter runs the attachment
action. Esc cancels ingestion and returns to the composer. Once a draft update
is dispatched, Esc dismisses the input while that update continues; its result
is still shown. Images are sent only when you press Enter
in the message composer. A caption is optional, including for `/reply #m1`.

The attachment input supports:

- `/attach <path>` copies a PNG into the current saved session.
- `/attach --list` shows staged metadata and full host IDs.
- `/attach --remove <id>` removes that reference from the draft.
- `/attach --clipboard` reads a PNG from the macOS clipboard.
- `/attach --status` prints each recipient of the current draft with its full
  image-support reason, or `can receive images`. It never sends and leaves the
  caption and staged images unchanged.
- `/help` shows attachment instructions.

When a staged image's recipient can't receive it, the composer shows one short
line per affected recipient, `@<id> can't receive images` (or `... yet` while
support is not yet observed), followed by `Ctrl+O, /attach --status for
details.` Images need no room configuration; see
[provider and image limits](installation.md#provider-and-image-limits).

Tab completes action names, paths and staged removal IDs. Paths are absolute or
relative to the directory where Chittr launched. The entire remainder is one
literal pathname, so `/attach photo one.png` works. Use complete JSON quotes for
exact names, such as `/attach "./photo one.png"`. `/attach -- --list` selects a
file named `--list`. Explicit symlinks to regular files work. No shell expressions,
variables, globs, tilde expansion or shell-style escaped spaces are evaluated.
The ordinary composer retains its existing workspace-fenced file completion.

The shared attachment contract accepts complete PNGs up to 3 MiB each, 20
images per draft/message and 6 MiB total. The terminal does not resize or
convert images; the browser does. Source bytes are copied; the original
file can then move or disappear. Messages and drafts retain host IDs and display
metadata, never the selected source path or image bytes.

The clipboard reader uses the OS-shipped `/usr/bin/osascript` JXA runtime and
AppKit's `NSPasteboard.generalPasteboard.dataForType('public.png')`. It adds no
compiled helper or runtime dependency. Empty, text-only, unsupported image,
denied and failed reads preserve the draft. TIFF/JPEG-only clipboard images
aren't converted. Save a PNG and use the file action when clipboard ingestion
is unavailable. Ordinary Cmd+V/Ctrl+V text paste remains unchanged.

Drafts recover from the shared session store on resume or room switch. A send
uses the shared atomic attachment operation: a committed message clears its
matching draft and resolves a lost acknowledgement by operation ID. A failed
pre-commit send retains the draft. Conflicts preserve the newer accepted draft;
check it before retrying. Restart reads the authoritative saved draft and
messages, with no terminal-specific persistence store. History recall restores
text/addressing only and never restages an old image.

Only the terminal receives the file-ingestion capability. Browser command and
completion endpoints cannot use attachment paths or claim terminal authority.
Browser image upload continues through the shared byte-upload API.

## Validation

`npm run test:terminal` exercises the real raw-mode UI with deterministic peers.
The focused terminal tests also exercise delayed operations, room switches,
source replacement/growth and retry identity.

After `npm run build`, opt-in `python3 scripts/terminal-image-live.py <result.json>`
launches `dist/cli.js` through a PTY with disposable session storage and the
historical restricted Grok 1.0.13 tuple. Use that exact runtime for this legacy script; its model field was inferred from the old gate and is not current session-identity evidence. It tests file/symlink selection, removal,
clipboard ingestion and a private pixel assertion after deleting the source.
It seeds the clipboard only when empty and clears its fixture only if the
clipboard change count still matches. Private image and provider-session
artifacts are removed; the result contains metadata and pass/fail evidence.

The installation evidence (`terminal-images-2026-09-12.json`, private historical record) records
macOS 27.0, actual PNG clipboard staging and CLI-origin initial delivery through
Grok 1.0.13 / grok-4.6. This verifies #34's terminal route. #35 owns historical
retrieval and the fresh-session acceptance needed for persistent enablement.

## Grok 1.0.30 image coverage

After building, `scripts/grok-terminal-images.py` verifies first and later image
sends in one provider session, followed by older-image retrieval in a separate
room after a lossy checkpoint and actual `/reconnect @grok`, followed by
`/continue @grok` because reconnect leaves the agent on hold. Both rooms use
`dist/cli.js` through raw-mode PTYs. Ctrl+O stages each image, and Enter sends it.
The [current image inventory](image-support.md#grok-1030-image-coverage) links
sanitized evidence and exact runtime setup.

```sh
python3 scripts/grok-terminal-images.py --room restricted --output /private/tmp/grok-pty-restricted.json
python3 scripts/grok-terminal-images.py --room trusted --output /private/tmp/grok-pty-trusted.json
python3 scripts/grok-terminal-images.py --room trusted --trusted-commands --output /private/tmp/grok-pty-trusted-commands.json
```

The required `trusted` room enables edits, commands, network and host skills,
and requests `high` effort. Without `--trusted-commands` it uses sandboxed
commands, with no added trust grant. With the flag it resolves command mode
`trusted`, which is [#69's room](image-support.md#grok-observed-runtime-contract-and-1034-coverage-issue-69).
The driver fails a run whose observed command mode or source differs from the
requested room, and stamps every new record with issue 69. Restricted coverage disables all task permissions and host skills
and omits an effort request. The native process stays isolated in both rooms.

The observation preload records actual ACP session/model identity and the native
selected effort when present. Unknown effort remains unknown. It hashes native
image content and checks message/attachment/send associations, while the harness
compares private visual answers independently. Historical retrieval must discover
the attachment through public history before `read_attachment`; neither the
clean checkpoint seed nor the question includes its hidden ID or visual answer.
No image is automatically replayed. The harness discards terminal text and removes
the disposable images, private controls and saved provider state when it exits.
