import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSearchUrl, parseSearchResults } from "./search-results.js";

// A hand-written excerpt matching DuckDuckGo HTML endpoint's real result
// markup shape (result__a / result__snippet, uddg-wrapped redirect links) —
// captured structure, not a live fetch.
const FIXTURE_HTML = `
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FBerth&amp;rut=abc">
        Berth &amp; Docks - <b>Wikipedia</b>
      </a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FBerth">
      A <b>berth</b> is a designated location where a vessel can moor.
    </a>
  </div>
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fberth-os&amp;rut=def">
        Berth OS
      </a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fberth-os">
      The operating system that treats the agent as the primary user.
    </a>
  </div>
</div>
`;

test("buildSearchUrl encodes the query into DuckDuckGo's html endpoint", () => {
  assert.equal(buildSearchUrl("berth os"), "https://duckduckgo.com/html/?q=berth%20os");
});

test("parseSearchResults extracts title/url/snippet for each result", () => {
  const results = parseSearchResults(FIXTURE_HTML);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.title, "Berth & Docks - Wikipedia");
  assert.equal(results[0]!.url, "https://en.wikipedia.org/wiki/Berth");
  assert.equal(results[0]!.snippet, "A berth is a designated location where a vessel can moor.");
});

test("parseSearchResults decodes the uddg redirect wrapper back to the real target URL", () => {
  const results = parseSearchResults(FIXTURE_HTML);
  assert.equal(results[1]!.url, "https://example.com/berth-os");
});

test("parseSearchResults respects maxResults", () => {
  const results = parseSearchResults(FIXTURE_HTML, 1);
  assert.equal(results.length, 1);
});

test("parseSearchResults returns an empty array for html with no matching markup", () => {
  assert.deepEqual(parseSearchResults("<html><body>no results here</body></html>"), []);
});
