import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateAddr } from "../../src/auth/cimd.js";

test("blocks private/loopback/link-local IPv4", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.0.1", "172.31.255.255", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255"]) {
    assert.equal(isPrivateAddr(ip), true, `${ip} should be private`);
  }
});

test("allows public IPv4", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "100.63.0.1"]) {
    assert.equal(isPrivateAddr(ip), false, `${ip} should be public`);
  }
});

test("blocks loopback/link-local/ULA IPv6", () => {
  for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "fec0::1"]) {
    assert.equal(isPrivateAddr(ip), true, `${ip} should be private`);
  }
});

test("blocks IPv4-mapped IPv6 that wrap a private v4", () => {
  for (const ip of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:192.168.1.1", "::127.0.0.1"]) {
    assert.equal(isPrivateAddr(ip), true, `${ip} should be private`);
  }
});

test("blocks 6to4 (2002::/16) wrapping a private v4", () => {
  assert.equal(isPrivateAddr("2002:7f00:0001::"), true); // 127.0.0.1
  assert.equal(isPrivateAddr("2002:c0a8:0101::1"), true); // 192.168.1.1
  assert.equal(isPrivateAddr("2002:0808:0808::"), false); // 8.8.8.8 -> public
});

test("blocks NAT64 (64:ff9b::/96) wrapping a private v4", () => {
  assert.equal(isPrivateAddr("64:ff9b::7f00:1"), true); // 127.0.0.1
  assert.equal(isPrivateAddr("64:ff9b::192.168.0.1"), true); // dotted tail
  assert.equal(isPrivateAddr("64:ff9b::808:808"), false); // 8.8.8.8 -> public
});

test("allows public IPv6", () => {
  assert.equal(isPrivateAddr("2606:4700:4700::1111"), false);
  assert.equal(isPrivateAddr("2001:4860:4860::8888"), false);
});
