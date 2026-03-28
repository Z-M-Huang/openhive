# Scenario 5: Stress, Recovery & Edge Cases

**Run the Clean Restart Helper from setup.md.**

#### Part A: Setup State

1. Send: "Create a team called stress-team for testing. Accept keywords: testing"
2. Write memory: `echo "Stress test baseline" > /app/openhive/.run/teams/main/memory/MEMORY.md`
3. VERIFY: stress-team in org_tree, MEMORY.md exists

#### Part B: Stress Test — 5 Rapid Concurrent Messages

4. Write a concurrent WS script (`/app/openhive/backend/ws-stress.cjs`):
   ```javascript
   const WebSocket = require('ws');
   const messages = [
     'What is 2+2?',
     'What is the capital of France?',
     'List 3 colors',
     'What teams do you have?',
     'Who are you?',
   ];
   let completed = 0;
   let successes = 0;
   let failures = 0;
   for (let i = 0; i < messages.length; i++) {
     const ws = new WebSocket('ws://localhost:8080/ws');
     const allMsgs = [];
     ws.on('open', () => ws.send(JSON.stringify({ content: messages[i] })));
     ws.on('message', (d) => {
       const p = JSON.parse(d.toString());
       if (p.type === 'notification') return; // skip async notifications
       allMsgs.push(p);
       if (p.type === 'response') {
         console.log(`---RESPONSE ${i + 1} OK (${allMsgs.length} messages, types: ${allMsgs.map(m=>m.type).join(',')})---`);
         console.log((p.content || '').slice(0, 200));
         successes++;
       } else if (p.type === 'error') {
         console.log(`---RESPONSE ${i + 1} ERROR: ${p.error}---`);
         failures++;
       } else { return; } // ack/progress — keep waiting
       completed++;
       ws.close();
       if (completed === messages.length) {
         console.log(`\nSUMMARY: ${successes} successes, ${failures} failures`);
         process.exit(failures > 0 ? 1 : 0);
       }
     });
     ws.on('error', (e) => {
       console.error(`WS_ERROR ${i + 1}: ${e.message}`);
       failures++;
       completed++;
       if (completed === messages.length) process.exit(1);
     });
   }
   setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 300000);
   ```

   Run: `node /app/openhive/backend/ws-stress.cjs`

5. VERIFY: All 5 got responses (no crashes)
6. VERIFY: `curl -sf http://localhost:8080/health` returns 200

#### Part C: Per-Socket Request Serialization

7. Test that a second message on the same socket while the first is processing gets rejected:
   ```bash
   cat > /app/openhive/backend/ws-concurrent.cjs << 'EOF'
   const WebSocket = require('ws');
   const ws = new WebSocket('ws://localhost:8080/ws');
   const allMsgs = [];
   ws.on('open', () => {
     // Send two messages immediately on the same socket
     ws.send(JSON.stringify({ content: 'Tell me a long story about dragons' }));
     // Send second message 100ms later (first is still processing)
     setTimeout(() => {
       ws.send(JSON.stringify({ content: 'What is 1+1?' }));
     }, 100);
   });
   ws.on('message', (d) => {
     const p = JSON.parse(d.toString());
     allMsgs.push(p);
     console.log('MSG: type=' + p.type + ' content=' + (p.content || p.error || '').slice(0, 100));
     // Wait for both the error and the response to come back
     const hasResponse = allMsgs.some(m => m.type === 'response');
     const hasError = allMsgs.some(m => m.type === 'error' && (m.error || '').includes('request in progress'));
     if (hasResponse && hasError) {
       console.log('SERIALIZATION_VERIFIED: Got both response and "request in progress" error');
       ws.close();
       process.exit(0);
     }
   });
   ws.on('error', (e) => { console.error('WS_ERROR:', e.message); process.exit(1); });
   setTimeout(() => {
     const hasError = allMsgs.some(m => m.type === 'error' && (m.error || '').includes('request in progress'));
     const hasResponse = allMsgs.some(m => m.type === 'response');
     console.log('TIMEOUT: serialization error received=' + hasError + ' response received=' + hasResponse);
     console.log('All messages: ' + JSON.stringify(allMsgs.map(m => ({type: m.type, content: (m.content||m.error||'').slice(0,80)}))));
     process.exit(hasError && hasResponse ? 0 : 2);
   }, 240000);
   EOF
   node /app/openhive/backend/ws-concurrent.cjs
   ```
   - VERIFY: Output contains "request in progress" error AND a successful response
   - This proves per-socket request serialization works

#### Part D: Recovery After Restart

8. `sudo docker restart openhive` — wait for health

9. VERIFY post-restart:
   ```bash
   # org_tree still has teams
   node -e "
   const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   console.log(JSON.stringify(D.prepare('SELECT name FROM org_tree').all()));
   D.close();
   "
   # MEMORY.md still exists
   cat /app/openhive/.run/teams/main/memory/MEMORY.md
   # Config files intact
   cat /app/openhive/.run/teams/stress-team/config.yaml
   # Recovery log
   sudo docker logs openhive 2>&1 | grep "Recovery"
   ```

10. Send: "Hello, are you working?"
    - VERIFY: Normal response (system works after restart)

11. VERIFY: Health still 200

#### Part E: Cleanup

12. Send: "Shut down stress-team"
13. Remove test files:
    ```bash
    rm -f /app/openhive/.run/teams/main/memory/MEMORY.md
    rm -f /app/openhive/backend/ws-stress.cjs
    rm -f /app/openhive/backend/ws-concurrent.cjs
    ```

**Report:** All 5 concurrent messages got responses? Per-socket serialization works? Health stable? Recovery preserved all state? System functional after stress?
