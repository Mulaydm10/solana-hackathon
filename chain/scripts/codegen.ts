// Regenerate the typed Kit client in src/generated from the Anchor IDL (program/deal_escrow.json).
import { readFileSync } from "node:fs";
import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";

const idl = JSON.parse(readFileSync(new URL("../program/deal_escrow.json", import.meta.url), "utf8"));
const codama = createFromRoot(rootNodeFromAnchor(idl));
await codama.accept(renderVisitor(new URL("..", import.meta.url).pathname, { deleteFolderBeforeRendering: true, syncPackageJson: false }));
