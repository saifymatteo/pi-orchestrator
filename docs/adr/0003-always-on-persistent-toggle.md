# Always-on engagement with persistent toggle

The extension's purpose is to force delegation without the user asking for it, so engagement defaults to on for every session. `/orchestrator` toggles it and **writes the `enabled` flag back to `~/.pi/agent/orchestrator.json`**, so a disengaged state persists across sessions — the user chose persistence over session-only override, accepting the "forgot it's off" risk. To defuse that, the extension notifies on startup when it is disengaged and shows state in the status area.
