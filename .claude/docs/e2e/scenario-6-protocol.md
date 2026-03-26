# Scenario 6: Progressive WS Responses

**Run the Clean Restart Helper from setup.md.**

This scenario specifically tests the new progressive response protocol: ack, progress, and response message types.

#### Part A: Message Type Verification

1. Write a WS script that captures all message types for a complex request:
   ```bash
   cat > /app/openhive/backend/ws-progressive.cjs << 'EOF'
   const WebSocket = require('ws');
   const ws = new WebSocket('ws://localhost:8080/ws');
   const allMsgs = [];
   ws.on('open', () => {
     // Send a request that requires tool use (should trigger ack + progress + response)
     ws.send(JSON.stringify({ content: 'Create a team called progressive-test for QA testing. Accept keywords: testing, qa' }));
   });
   ws.on('message', (d) => {
     const p = JSON.parse(d.toString());
     allMsgs.push({ type: p.type, ts: Date.now(), contentPreview: (p.content || p.error || '').slice(0, 150) });
     console.log(`[${allMsgs.length}] type=${p.type} content=${(p.content || p.error || '').slice(0, 150)}`);
     if (p.type === 'response' || p.type === 'error') {
       console.log('\n=== PROTOCOL ANALYSIS ===');
       const types = allMsgs.map(m => m.type);
       console.log('Message sequence: ' + types.join(' -> '));
       console.log('Total messages: ' + allMsgs.length);
       console.log('Has ack: ' + types.includes('ack'));
       console.log('Has progress: ' + types.includes('progress'));
       console.log('Has response: ' + types.includes('response'));
       if (allMsgs.length >= 2) {
         const elapsed = allMsgs[allMsgs.length - 1].ts - allMsgs[0].ts;
         console.log('Total elapsed: ' + elapsed + 'ms');
       }
       // Verify ack comes first if present
       const ackIdx = types.indexOf('ack');
       const respIdx = types.indexOf('response');
       if (ackIdx >= 0 && respIdx >= 0) {
         console.log('Ack before response: ' + (ackIdx < respIdx));
       }
       ws.close();
       process.exit(0);
     }
   });
   ws.on('error', (e) => { console.error('WS_ERROR:', e.message); process.exit(1); });
   setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 300000);
   EOF
   node /app/openhive/backend/ws-progressive.cjs
   ```

2. VERIFY from output:
   - **Message sequence** shows at least `ack -> response` or `response` (simple requests may skip ack)
   - If `ack` is present, it comes BEFORE `response`
   - `ack` content is AI-generated text (not a static "Processing your request...")
   - `response` contains the final result
   - If `progress` is present, it contains tool execution info

#### Part B: Message Type Structure

3. Send a simple question that should NOT require tools (fast response):
   ```bash
   node -e "
   const ws = new (require('/app/openhive/backend/node_modules/ws'))('ws://localhost:8080/ws');
   const msgs = [];
   ws.on('open', () => ws.send(JSON.stringify({content:'What is 2+2?'})));
   ws.on('message', (d) => {
     const p = JSON.parse(d.toString());
     msgs.push(p);
     console.log('TYPE=' + p.type + ' CONTENT=' + (p.content || p.error || '').slice(0, 200));
     if (p.type === 'response' || p.type === 'error') {
       console.log('TOTAL_MESSAGES=' + msgs.length);
       console.log('TYPES=' + msgs.map(m => m.type).join(','));
       ws.close();
       process.exit(0);
     }
   });
   ws.on('error', (e) => { console.error('WS_ERROR:', e.message); process.exit(1); });
   setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 240000);
   "
   ```
   - VERIFY: All messages have valid `type` field (one of: ack, progress, response, error)
   - VERIFY: Final message has `type: "response"` with a `content` field containing the answer
   - VERIFY: `content` field is a string (not undefined/null)

4. VERIFY all response JSON structure:
   - Every message from the server should be valid JSON
   - Every message should have a `type` field
   - `ack` and `response` messages should have a `content` field
   - `progress` messages should have a `content` field
   - `error` messages should have an `error` field

#### Part C: Error Handling Preserves Protocol

5. Send an empty content message:
   ```bash
   node -e "
   const ws = new (require('/app/openhive/backend/node_modules/ws'))('ws://localhost:8080/ws');
   ws.on('open', () => ws.send(JSON.stringify({content:''})));
   ws.on('message', (d) => {
     const p = JSON.parse(d.toString());
     console.log('TYPE=' + p.type);
     console.log('ERROR=' + (p.error || 'none'));
     console.log('HAS_TYPE_FIELD=' + ('type' in p));
     ws.close();
     process.exit(0);
   });
   ws.on('error', (e) => { console.error('WS_ERROR:', e.message); process.exit(1); });
   setTimeout(() => process.exit(2), 10000);
   "
   ```
   - VERIFY: Response has `type: "error"` with an `error` field

6. Send invalid JSON:
   ```bash
   node -e "
   const ws = new (require('/app/openhive/backend/node_modules/ws'))('ws://localhost:8080/ws');
   ws.on('open', () => ws.send('not json'));
   ws.on('message', (d) => {
     const p = JSON.parse(d.toString());
     console.log('TYPE=' + p.type);
     console.log('ERROR=' + (p.error || 'none'));
     ws.close();
     process.exit(0);
   });
   ws.on('error', (e) => { console.error('WS_ERROR:', e.message); process.exit(1); });
   setTimeout(() => process.exit(2), 10000);
   "
   ```
   - VERIFY: Response has `type: "error"` with `error: "invalid JSON"`

#### Part D: Cleanup

7. Send: "Shut down progressive-test"
8. ```bash
   rm -f /app/openhive/backend/ws-progressive.cjs
   ```
9. VERIFY: Health still 200

**Report:** Progressive response protocol working? Message types correct? Ack before response? Error messages follow protocol? JSON structure consistent?
