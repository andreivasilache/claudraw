## Architecture canvas

This project has an Excalidraw canvas (`.canvas/`), served by the `canvas` tool. Start it with `canvas` (project list at http://127.0.0.1:8787, this project at `/p/<id>`); the `canvas` MCP server in `.mcp.json` only works while it is running.

- **"Diagram" means this canvas.** To make, draw, add or change a diagram, flow, timeline or boxes, use the `canvas` MCP tools, not the Artifact tool, an HTML/SVG file or an Excalidraw connector (unless the user asks for an artifact, a page or a shareable link). If the canvas tools are not available, say the canvas server is not running and ask the user to start it with `canvas`; do not fall back to anything else.
- When the user refers to something on the diagram ("this box", "these", "here") or names no target, call `get_selection` first.
- The rules for working with the canvas (selection scope, notes, context, how to draw) are the `canvas` server's own instructions and `read_guide`; they update with the tool, so follow them instead of copying them here. Never edit the `.canvas/` files by hand.
