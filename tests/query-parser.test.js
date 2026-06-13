import test from "node:test";
import assert from "node:assert/strict";
import { parseRecruiterQuery } from "../query-parser.js";

test("parseRecruiterQuery routes candidate location filters to location_filter_search", () => {
  const parsed = parseRecruiterQuery("candidates from Delhi");

  assert.equal(parsed.intent, "location_filter_search");
  assert.equal(parsed.filters.location, "Delhi");
});
test("parseRecruiterQuery routes location summaries to location_analytics", () => {
  const parsed = parseRecruiterQuery("which locations are available");

  assert.equal(parsed.intent, "location_analytics");
});

test("parseRecruiterQuery keeps best-role questions in candidate_search", () => {
  const parsed = parseRecruiterQuery("who is best backend dev");

  assert.equal(parsed.intent, "candidate_search");
  assert.equal(parsed.filters.role, "backend");
});
