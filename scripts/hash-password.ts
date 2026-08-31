import argon2 from "argon2";

function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run this command in an interactive terminal");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();

    function finish() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
    }

    function onData(chunk: string | Buffer) {
      const input = chunk.toString();
      for (const character of input) {
        if (character === "\u0003") {
          finish();
          reject(new Error("Cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    }

    process.stdin.on("data", onData);
  });
}

async function main() {
  const password = await readHidden("Passphrase (hidden): ");
  if (password.length < 14) throw new Error("Passphrase must contain at least 14 characters");
  const confirmation = await readHidden("Confirm passphrase:  ");
  if (password !== confirmation) throw new Error("Passphrases do not match");
  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
  });
  console.log(`APP_PASSWORD_HASH=${hash.replaceAll("$", "\\$")}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Could not generate password hash");
  process.exitCode = 1;
});
