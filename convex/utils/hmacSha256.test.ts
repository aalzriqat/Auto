import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hmacSha256, hmacSha256Hex, sha256 } from "./hmacSha256";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const ascii = (text: string) => new TextEncoder().encode(text);
const bytes = (value: string) => Uint8Array.from(value.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));

describe("sha256", () => {
  it("matches the FIPS 180 vectors", () => {
    expect(hex(sha256(ascii("")))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(sha256(ascii("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hex(sha256(ascii("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });
});

describe("hmacSha256 (RFC 4231)", () => {
  it("test case 1", () => {
    expect(hex(hmacSha256(bytes("0b".repeat(20)), ascii("Hi There")))).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });
  it("test case 2", () => {
    expect(hex(hmacSha256(ascii("Jefe"), ascii("what do ya want for nothing?")))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });
  it("test case 3", () => {
    expect(hex(hmacSha256(bytes("aa".repeat(20)), bytes("dd".repeat(50))))).toBe(
      "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe",
    );
  });
  it("test case 6 (a key longer than the block size)", () => {
    expect(
      hex(hmacSha256(bytes("aa".repeat(131)), ascii("Test Using Larger Than Block-Size Key - Hash Key First"))),
    ).toBe("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
  });
});

describe("hmacSha256Hex agrees with Node's createHmac", () => {
  it.each([
    ["0123456789abcdef0123456789abcdef", "org123:run-1"],
    ["k", ""],
    ["é-unicode-key-ü", "message with ünïcode and a long tail ".repeat(9)],
    ["x".repeat(200), "m".repeat(1000)],
  ])("key %# ", (key, message) => {
    expect(hmacSha256Hex(key, message)).toBe(createHmac("sha256", key).update(message).digest("hex"));
  });
});
