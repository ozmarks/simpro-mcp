import { test } from "node:test";
import assert from "node:assert/strict";
import { FlowStore } from "../../src/auth/flowState.js";

const flow = {
  clientId: "c1",
  codeChallenge: "ch",
  claudeState: "st",
  claudeRedirectUri: "https://claude.example/cb",
  confidential: false,
};

const code = {
  clientId: "c1",
  simproCode: "abc",
  codeChallenge: "ch",
  claudeRedirectUri: "https://claude.example/cb",
  confidential: false,
};

// TTL expiry (the 5-minute window) is deferred: exercising it would require
// faking Date.now, which the no-mock test constraint excludes. The single-use
// take semantics below are the load-bearing contract.

test("startFlow then takeFlow returns the flow once, then undefined", () => {
  const store = new FlowStore();
  const handle = store.startFlow(flow);
  assert.deepEqual(store.takeFlow(handle), flow);
  assert.equal(store.takeFlow(handle), undefined);
});

test("takeFlow of an unknown handle returns undefined", () => {
  const store = new FlowStore();
  assert.equal(store.takeFlow("missing"), undefined);
});

test("issueCode then takeCode returns the code once, then undefined", () => {
  const store = new FlowStore();
  const brokerCode = store.issueCode(code);
  assert.deepEqual(store.takeCode(brokerCode), code);
  assert.equal(store.takeCode(brokerCode), undefined);
});

test("takeCode of an unknown brokerCode returns undefined", () => {
  const store = new FlowStore();
  assert.equal(store.takeCode("missing"), undefined);
});

test("flow and code namespaces are independent", () => {
  const store = new FlowStore();
  const handle = store.startFlow(flow);
  assert.equal(store.takeCode(handle), undefined);
  // The flow is still retrievable — takeCode didn't consume it.
  assert.deepEqual(store.takeFlow(handle), flow);
});
