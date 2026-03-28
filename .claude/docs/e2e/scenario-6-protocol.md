# Scenario 6: Progressive WS Responses

**Run the Clean Restart Helper from setup.md. Then reset harness and reconnect:**
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

This scenario specifically tests the progressive response protocol: ack, progress, and response message types.

#### Part A: Message Type Verification

1. Send a complex request that requires tool use (should trigger ack + progress + response):
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Create a team called progressive-test for QA testing. Accept keywords: testing, qa","timeout":300000}
   EOF
   ```

2. VERIFY from response:
   - `.exchange` array shows the message sequence (e.g., ack → progress → response)
   - Each entry has `seq`, `type`, `content`, `ts` fields
   - If `ack` is present, its index in `.exchange` is BEFORE `response`
   - `ack` content is AI-generated text (not a static "Processing your request...")
   - Terminal entry has `type: "response"` with the final result
   - If `progress` entries exist, they contain tool execution info

   Verify ordering explicitly:
   ```bash
   curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":20}'
   ```
   - Inspect seq numbers: ack seq < response seq

#### Part B: Message Type Structure

3. Send a simple question that should NOT require tools (fast response):
   ```bash
   curl -s localhost:9876/send -d '{"name":"main","content":"What is 2+2?","timeout":60000}'
   ```
   - VERIFY: `.exchange` entries all have valid `type` field (one of: ack, progress, response, error)
   - VERIFY: Terminal entry has `type: "response"` with a `content` field containing the answer
   - VERIFY: `.final` is a string (not undefined/null)

4. VERIFY all response JSON structure from traffic log:
   ```bash
   curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":50}'
   ```
   - Every received frame should have a `type` field
   - `ack` and `response` frames have `content`
   - `progress` frames have `content`
   - `error` frames have `content` (which contains the error message)

#### Part C: Error Handling Preserves Protocol

5. Send empty content:
   ```bash
   curl -s localhost:9876/send_raw -d '{"name":"main","payload":"{\"content\":\"\"}","timeout":10000}'
   ```
   - VERIFY: `.exchange` contains a frame with `type: "error"`

6. Send invalid JSON:
   ```bash
   curl -s localhost:9876/send_raw -d '{"name":"main","payload":"not json","timeout":10000}'
   ```
   - VERIFY: `.exchange` contains a frame with `type: "error"` and content mentioning "invalid JSON"

#### Part D: Cleanup

7. ```bash
   curl -s localhost:9876/send -d '{"name":"main","content":"Shut down progressive-test","timeout":300000}'
   ```

8. VERIFY: Health still 200

**Report:** Progressive response protocol working? Message types correct? Ack before response? Error messages follow protocol? JSON structure consistent?
