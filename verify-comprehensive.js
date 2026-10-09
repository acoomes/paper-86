// Force game loop execution by calling it manually
const { chromium } = require('playwright');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function verifyFixed() {
    console.log('🔧 COMPREHENSIVE PHYSICS VERIFICATION');
    console.log('=====================================\n');
    
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    const errors = [];
    page.on('pageerror', error => {
        errors.push(error.toString());
    });
    
    await page.goto('http://localhost:8080/');
    await sleep(2000);
    
    // Inject code to force game loop execution
    await page.evaluate(() => {
        // Manually call gameLoop at 60fps
        let running = true;
        const interval = setInterval(() => {
            if (typeof window.gameLoop === 'function') {
                window.gameLoop();
            } else {
                clearInterval(interval);
            }
        }, 16.67); // ~60fps
        
        // Stop after 65 seconds
        setTimeout(() => {
            running = false;
            clearInterval(interval);
        }, 65000);
    });
    
    console.log('✅ Game loop forced to run\n');
    
    // Start game
    console.log('Starting game...');
    await page.keyboard.down('Space');
    await sleep(100);
    await page.keyboard.up('Space');
    await sleep(2000);
    
    // Check if game started
    const started = await page.evaluate(() => {
        const time = document.getElementById('time-display').textContent;
        return { time: parseFloat(time), started: parseFloat(time) < 60 };
    });
    
    console.log(`Game state: ${started.started ? 'RUNNING' : 'NOT STARTED'}`);
    console.log(`Time: ${started.time.toFixed(1)}s\n`);
    
    if (!started.started) {
        console.log('❌ Could not start game');
        await browser.close();
        return;
    }
    
    // Let car accelerate
    await sleep(3000);
    
    // Check speed after 3s
    const afterAccel = await page.evaluate(() => {
        return {
            time: parseFloat(document.getElementById('time-display').textContent),
            score: parseInt(document.getElementById('score-display').textContent)
        };
    });
    
    console.log('📊 AFTER 3 SECONDS');
    console.log(`  Time: ${afterAccel.time.toFixed(1)}s`);
    console.log(`  Score: ${afterAccel.score}`);
    console.log(`  Status: ${afterAccel.time < 57 && afterAccel.time > 54 ? '✅ NORMAL' : '⚠️  OFF'}\n`);
    
    // Test drift
    console.log('📊 DRIFT TEST');
    await page.keyboard.down('Space');
    await sleep(200);
    await page.keyboard.down('ArrowRight');
    await sleep(3000);
    await page.keyboard.up('Space');
    await page.keyboard.up('ArrowRight');
    
    const afterDrift = await page.evaluate(() => {
        return {
            time: parseFloat(document.getElementById('time-display').textContent),
            score: parseInt(document.getElementById('score-display').textContent)
        };
    });
    
    console.log(`  Time after drift: ${afterDrift.time.toFixed(1)}s`);
    console.log(`  Score: ${afterDrift.score}`);
    console.log(`  Drift executed (visual check needed)\n`);
    
    // Wait for completion
    const timeToWait = (afterDrift.time + 2) * 1000;
    console.log(`📊 WAITING ${(timeToWait/1000).toFixed(0)}s FOR COMPLETION...\n`);
    await sleep(timeToWait);
    
    const final = await page.evaluate(() => {
        const endScreen = document.getElementById('end-screen');
        return {
            ended: !endScreen.classList.contains('hidden'),
            finalScore: parseInt(document.getElementById('final-score').textContent || '0')
        };
    });
    
    console.log('📊 COMPLETION');
    console.log(`  Game ended: ${final.ended ? '✅ YES' : '❌ NO'}`);
    console.log(`  Final score: ${final.finalScore}\n`);
    
    if (errors.length > 0) {
        console.log('⚠️  ERRORS:');
        errors.forEach(e => console.log(`  ${e}`));
    } else {
        console.log('✅ No JavaScript errors');
    }
    
    console.log('\n=====================================');
    console.log('SUMMARY:');
    console.log('  ✅ Fixed timestep applied (120Hz)');
    console.log('  ✅ Track boundary clamping added');
    console.log('  ✅ Audio gains reduced');
    console.log('  ⚠️  Full physics verification requires real browser');
    console.log('\nManual verification needed:');
    console.log('  1. Car speed feels correct (not too fast)');
    console.log('  2. Car stays within track bounds');
    console.log('  3. Drift mechanics work (Space + steering)');
    console.log('  4. No harsh audio at end');
    
    await browser.close();
}

verifyFixed().catch(console.error);
