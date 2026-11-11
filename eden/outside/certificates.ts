import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";

// Just enough X.509 to issue a certificate for any host Aurral calls, so the stand-in
// can answer HTTPS requests. Node has no API for writing certificates.

const NOT_BEFORE = "200101000000Z";
const NOT_AFTER = "491231235959Z";
const COMMON_NAME = "2.5.4.3";
const ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const BASIC_CONSTRAINTS = "2.5.29.19";
const SUBJECT_ALT_NAME = "2.5.29.17";
const DNS_NAME = 0x82;

function der(tag: number, ...parts: Uint8Array[]) {
  const body = Buffer.concat(parts);
  const size = [];
  for (let rest = body.length; rest > 0; rest >>= 8) size.unshift(rest & 0xff);
  const length = body.length < 0x80 ? [body.length] : [0x80 | size.length, ...size];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

const sequence = (...parts: Uint8Array[]) => der(0x30, ...parts);
const text = (tag: number, value: string) => der(tag, Buffer.from(value, "utf8"));
const integer = (value: Uint8Array) =>
  der(0x02, (value[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);

function oid(dotted: string) {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const group = [part & 0x7f];
    for (let value = part >> 7; value > 0; value >>= 7) group.unshift(0x80 | (value & 0x7f));
    bytes.push(...group);
  }
  return der(0x06, Buffer.from(bytes));
}

const name = (commonName: string) =>
  sequence(der(0x31, sequence(oid(COMMON_NAME), text(0x0c, commonName))));

const pem = (label: string, body: Buffer) =>
  `-----BEGIN ${label}-----\n${body.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;

function certificate({
  subject,
  issuer,
  publicKey,
  signingKey,
  extension,
}: {
  subject: string;
  issuer: string;
  publicKey: string;
  signingKey: string;
  extension: Buffer;
}) {
  const algorithm = sequence(oid(ECDSA_WITH_SHA256));
  const body = sequence(
    der(0xa0, integer(Buffer.from([2]))),
    integer(createHash("sha256").update(subject).digest().subarray(0, 8)),
    algorithm,
    name(issuer),
    sequence(text(0x17, NOT_BEFORE), text(0x17, NOT_AFTER)),
    name(subject),
    createPublicKey(publicKey).export({ type: "spki", format: "der" }),
    der(0xa3, sequence(extension)),
  );
  const signature = sign("sha256", body, createPrivateKey(signingKey));
  return pem("CERTIFICATE", sequence(body, algorithm, der(0x03, Buffer.from([0]), signature)));
}

const keyPair = () =>
  generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

const AUTHORITY = "Aurral Eden";

export type Authority = { certificate: string; key: string };

export function createAuthority(): Authority {
  const { publicKey, privateKey } = keyPair();
  const certificateAuthority = sequence(
    oid(BASIC_CONSTRAINTS),
    der(0x01, Buffer.from([0xff])),
    der(0x04, sequence(der(0x01, Buffer.from([0xff])))),
  );
  return {
    key: privateKey,
    certificate: certificate({
      subject: AUTHORITY,
      issuer: AUTHORITY,
      publicKey,
      signingKey: privateKey,
      extension: certificateAuthority,
    }),
  };
}

export function hostIssuer(authority: Authority) {
  const { publicKey, privateKey } = keyPair();
  return (host: string) => ({
    key: privateKey,
    cert: certificate({
      subject: host,
      issuer: AUTHORITY,
      publicKey,
      signingKey: authority.key,
      extension: sequence(oid(SUBJECT_ALT_NAME), der(0x04, sequence(text(DNS_NAME, host)))),
    }),
  });
}
