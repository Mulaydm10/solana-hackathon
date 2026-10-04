// Regenerate the typed Kit client in src/generated from the Anchor IDL (program/deal_escrow.json).
import { readFileSync } from "node:fs";
import { createFromRoot, flattenInstructionDataArgumentsVisitor, unwrapDefinedTypesVisitor, updateInstructionsVisitor } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";

const idl = JSON.parse(readFileSync(new URL("../program/deal_escrow.json", import.meta.url), "utf8"));
const codama = createFromRoot(rootNodeFromAnchor(idl));
// create_deal's DealLink is optional: it must be passed only for a deal opened from a listing, so
// the client must not fill in its PDA by default (the program refuses a link without a listing).
codama.update(updateInstructionsVisitor({ createDeal: { accounts: { link: { defaultValue: null } } } }));
// DealParams is shared by create_deal and agent_open_deal; keep its fields flat in both builders
// (callers pass `amount`, `deadline`, ... directly, as before v3).
codama.update(unwrapDefinedTypesVisitor(["dealParams"]));
codama.update(flattenInstructionDataArgumentsVisitor());
await codama.accept(renderVisitor(new URL("..", import.meta.url).pathname, { deleteFolderBeforeRendering: true, syncPackageJson: false }));
