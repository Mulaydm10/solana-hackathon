// Every tool, in the order MCP clients list them. One line per file in this folder.
import type { AnyTool } from "../tool.ts";
import programInfo from "./program_info.ts";
import findListings from "./find_listings.ts";
import getListing from "./get_listing.ts";
import setupPolicy from "./setup_policy.ts";
import buy from "./buy.ts";
import dealStatus from "./deal_status.ts";
import release from "./release.ts";
import challenge from "./challenge.ts";
import hireTeam from "./hire_team.ts";
import missionStatus from "./mission_status.ts";
import draftListing from "./draft_listing.ts";
import publishListing from "./publish_listing.ts";
import demandBoard from "./demand_board.ts";
import myListings from "./my_listings.ts";
import callService from "./call_service.ts";

export const TOOLS: readonly AnyTool[] = [programInfo, findListings, getListing, setupPolicy, buy, dealStatus, release, challenge, hireTeam, missionStatus, draftListing, publishListing, demandBoard, myListings, callService];
