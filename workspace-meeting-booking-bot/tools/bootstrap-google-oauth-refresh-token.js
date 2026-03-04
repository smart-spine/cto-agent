#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");

const {
  exchangeGoogleAuthCodeForRefreshToken,
  writeSecretRefValueFile,
} = require("./book-google-calendar-event.js");

function parseArgs(argv) {
  const parsed = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }

    const eqIndex = arg.indexOf("=");
    if (eqIndex > -1) {
      const key = arg.slice(2, eqIndex);
      const value = arg.slice(eqIndex + 1);
      parsed[key] = value;
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = "true";
    }
  }
  return parsed;
}

function usage() {
  return [
    "Usage:",
    "  node tools/bootstrap-google-oauth-refresh-token.js \\",
    "    --auth-code '<GOOGLE_AUTH_CODE>' \\",
    "    --client-secret-file /secure/path/client_secret.json \\",
    "    --refresh-token-file /secure/path/google-oauth-refresh-token.json \\",
    "    [--redirect-uri '<REDIRECT_URI>']",
    "",
    "Notes:",
    "  - Keep both files outside version control and chmod 600.",
    "  - Script never prints token values.",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help === "true" || args.h === "true") {
    console.log(usage());
    return;
  }

  const authCode = typeof args["auth-code"] === "string" ? args["auth-code"].trim() : "";
  const clientSecretFile =
    typeof args["client-secret-file"] === "string"
      ? args["client-secret-file"].trim()
      : "";
  const refreshTokenFile =
    typeof args["refresh-token-file"] === "string"
      ? args["refresh-token-file"].trim()
      : "";
  const redirectUri =
    typeof args["redirect-uri"] === "string" && args["redirect-uri"].trim()
      ? args["redirect-uri"].trim()
      : undefined;

  if (!authCode || !clientSecretFile || !refreshTokenFile) {
    throw new Error(
      "Missing required args: --auth-code, --client-secret-file, --refresh-token-file\n\n" +
        usage(),
    );
  }

  const rawClientSecret = await fs.readFile(clientSecretFile, "utf8");
  const tokenResult = await exchangeGoogleAuthCodeForRefreshToken({
    authCode,
    redirectUri,
    credentials: {
      clientSecret: rawClientSecret,
    },
  });

  const absoluteOutput = path.resolve(refreshTokenFile);
  await writeSecretRefValueFile({
    filePath: absoluteOutput,
    value: tokenResult.refreshToken,
  });

  process.stdout.write(`Refresh token stored at ${absoluteOutput}\n`);
}

main().catch((error) => {
  const message = error && error.message ? error.message : "Bootstrap failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
