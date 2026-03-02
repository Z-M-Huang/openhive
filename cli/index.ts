import { createInterface } from "readline";

const serverUrl = process.env.OPENHIVE_URL || "http://localhost:8080";

let inflight = false;

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "> ",
});

console.log(`OpenHive CLI — ${serverUrl}`);
console.log("Type a message or Ctrl+D to exit\n");
rl.prompt();

rl.on("line", async (line: string) => {
  const content = line.trim();
  if (!content) {
    rl.prompt();
    return;
  }

  inflight = true;
  try {
    process.stdout.write("...");
    const res = await fetch(`${serverUrl}/api/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

    const json = (await res.json()) as {
      data?: { response?: string };
      error?: { message?: string };
    };

    process.stdout.write("\r   \r");

    if (!res.ok) {
      console.error(`Error: ${json.error?.message || res.statusText}`);
    } else {
      console.log(json.data?.response || "(empty response)");
    }
  } catch (err: unknown) {
    process.stdout.write("\r   \r");
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Connection error: ${msg}`);
  } finally {
    inflight = false;
  }

  console.log();
  rl.prompt();
});

rl.on("close", () => {
  console.log("\nGoodbye!");
  if (!inflight) {
    process.exit(0);
  }
  // If a request is in-flight, let the event loop drain naturally
  // so the response/error is printed before exiting.
});
