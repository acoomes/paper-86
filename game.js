// Paper 86 - 60-second drift racing game
// Canvas and game state
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

// Game state
let gameState = 'playing'; // 'playing', 'ended'
let score = 0;
let bestScore = parseInt(localStorage.getItem('paper86-best') || '0');
let timeLeft = 60;
let combo = 0;
let lastConeTime = 0;

// Input state
const keys = {};
let drifting = false;
let touchDrifting = false;

// Car state
const car = {
    x: 400,
    y: 600,
    vx: 0,
    vy: 0,
    angle: -Math.PI / 2, // facing up
    speed: 0,
    driftAngle: 0,
    width: 20,
    height: 36
};

// Physics constants
const ACCELERATION = 0.3;
const MAX_SPEED = 8;
const FRICTION = 0.97;
const TURN_SPEED = 0.06;
const DRIFT_TURN_SPEED = 0.09;
const DRIFT_FRICTION = 0.94;
const GRIP_FRICTION = 0.88;

// Camera
const camera = {
    x: 0,
    y: 0
};

// Tire marks
const tireMarks = [];
const MAX_TIRE_MARKS = 300;

// Track definition - closed circuit with curves
const trackWidth = 200;
const trackPoints = [
    { x: 400, y: 200 },
    { x: 700, y: 250 },
    { x: 900, y: 400 },
    { x: 850, y: 650 },
    { x: 600, y: 750 },
    { x: 350, y: 700 },
    { x: 200, y: 500 },
    { x: 250, y: 300 }
];

// Generate cones at strategic points
const cones = [
    { x: 550, y: 225, hit: false },
    { x: 820, y: 320, hit: false },
    { x: 780, y: 550, hit: false },
    { x: 520, y: 720, hit: false },
    { x: 280, y: 600, hit: false },
    { x: 240, y: 380, hit: false },
    { x: 320, y: 260, hit: false }
];

// Initialize
function init() {
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    // Keyboard controls
    window.addEventListener('keydown', (e) => {
        keys[e.key.toLowerCase()] = true;
        if (e.key.toLowerCase() === ' ') {
            e.preventDefault();
            drifting = true;
        }
        if (e.key.toLowerCase() === 'r' && gameState === 'ended') {
            restart();
        }
    });
    
    window.addEventListener('keyup', (e) => {
        keys[e.key.toLowerCase()] = false;
        if (e.key.toLowerCase() === ' ') {
            drifting = false;
        }
    });
    
    // Touch/mouse controls for drift
    canvas.addEventListener('pointerdown', (e) => {
        if (gameState === 'ended') {
            restart();
        } else {
            touchDrifting = true;
        }
    });
    
    canvas.addEventListener('pointerup', () => {
        touchDrifting = false;
    });
    
    // Mobile drift button
    const driftButton = document.getElementById('drift-button');
    driftButton.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        touchDrifting = true;
    });
    driftButton.addEventListener('pointerup', (e) => {
        e.preventDefault();
        touchDrifting = false;
    });
    
    // Show mobile controls on touch devices
    if ('ontouchstart' in window) {
        document.getElementById('mobile-controls').classList.remove('hidden');
    }
    
    gameLoop();
}

function resizeCanvas() {
    const container = document.getElementById('game-container');
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
}

function restart() {
    gameState = 'playing';
    score = 0;
    timeLeft = 60;
    combo = 0;
    car.x = 400;
    car.y = 600;
    car.vx = 0;
    car.vy = 0;
    car.angle = -Math.PI / 2;
    car.speed = 0;
    car.driftAngle = 0;
    tireMarks.length = 0;
    cones.forEach(cone => cone.hit = false);
    document.getElementById('end-screen').classList.add('hidden');
    lastConeTime = Date.now();
}

function updateCar(dt) {
    if (gameState !== 'playing') return;
    
    const isDrifting = drifting || touchDrifting;
    
    // Steering
    let steerInput = 0;
    if (keys['arrowleft'] || keys['a']) steerInput -= 1;
    if (keys['arrowright'] || keys['d']) steerInput += 1;
    
    // Acceleration (always accelerating forward)
    const accel = ACCELERATION;
    car.vx += Math.cos(car.angle) * accel;
    car.vy += Math.sin(car.angle) * accel;
    
    // Calculate speed
    car.speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    
    // Apply friction based on drift state
    const friction = isDrifting ? DRIFT_FRICTION : FRICTION;
    car.vx *= friction;
    car.vy *= friction;
    
    // Limit max speed
    if (car.speed > MAX_SPEED) {
        const scale = MAX_SPEED / car.speed;
        car.vx *= scale;
        car.vy *= scale;
        car.speed = MAX_SPEED;
    }
    
    // Turning
    if (steerInput !== 0 && car.speed > 0.5) {
        const turnSpeed = isDrifting ? DRIFT_TURN_SPEED : TURN_SPEED;
        const turnAmount = turnSpeed * steerInput * (car.speed / MAX_SPEED);
        car.angle += turnAmount;
        
        if (isDrifting) {
            // Drift: rear steps out
            car.driftAngle = Math.abs(turnAmount) * 8;
            // Apply lateral slip
            const lateralX = -Math.sin(car.angle) * turnAmount * 2;
            const lateralY = Math.cos(car.angle) * turnAmount * 2;
            car.vx += lateralX;
            car.vy += lateralY;
            
            // Add tire marks
            if (tireMarks.length < MAX_TIRE_MARKS && Math.random() > 0.3) {
                const offsetDist = 10;
                tireMarks.push({
                    x: car.x - Math.sin(car.angle) * offsetDist,
                    y: car.y + Math.cos(car.angle) * offsetDist,
                    angle: car.angle + (Math.random() - 0.5) * 0.3,
                    alpha: 0.8
                });
            }
        } else {
            // Grip: velocity aligns with car angle
            car.driftAngle *= 0.9;
            const targetVx = Math.cos(car.angle) * car.speed;
            const targetVy = Math.sin(car.angle) * car.speed;
            car.vx += (targetVx - car.vx) * GRIP_FRICTION;
            car.vy += (targetVy - car.vy) * GRIP_FRICTION;
        }
    } else {
        car.driftAngle *= 0.95;
    }
    
    // Update position
    car.x += car.vx;
    car.y += car.vy;
    
    // Check collisions
    checkCollisions();
    
    // Check cone collection
    checkCones();
    
    // Update score based on drift
    if (isDrifting && car.speed > 2) {
        const driftScore = car.driftAngle * car.speed * 0.5 * (combo > 0 ? 1 + combo * 0.1 : 1);
        score += driftScore;
    }
    
    // Fade tire marks
    tireMarks.forEach(mark => {
        mark.alpha *= 0.995;
    });
    tireMarks.splice(0, tireMarks.filter(m => m.alpha < 0.1).length);
}

function checkCollisions() {
    // Check if car is on track
    if (!isOnTrack(car.x, car.y)) {
        endGame();
    }
}

function isOnTrack(x, y) {
    // Find closest point on track centerline
    let minDist = Infinity;
    
    for (let i = 0; i < trackPoints.length; i++) {
        const p1 = trackPoints[i];
        const p2 = trackPoints[(i + 1) % trackPoints.length];
        
        const dist = distanceToSegment(x, y, p1.x, p1.y, p2.x, p2.y);
        minDist = Math.min(minDist, dist);
    }
    
    return minDist < trackWidth / 2;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    
    const nearestX = x1 + t * dx;
    const nearestY = y1 + t * dy;
    
    return Math.hypot(px - nearestX, py - nearestY);
}

function checkCones() {
    const now = Date.now();
    const coneRadius = 15;
    const comboWindow = 3000; // 3 seconds to maintain combo
    
    cones.forEach((cone, idx) => {
        if (cone.hit) return;
        
        const dist = Math.hypot(car.x - cone.x, car.y - cone.y);
        if (dist < coneRadius + car.width / 2) {
            cone.hit = true;
            combo++;
            score += 100 * combo;
            lastConeTime = now;
        }
    });
    
    // Check if combo should be dropped
    if (combo > 0 && now - lastConeTime > comboWindow) {
        combo = 0;
    }
}

function endGame() {
    gameState = 'ended';
    
    if (score > bestScore) {
        bestScore = Math.floor(score);
        localStorage.setItem('paper86-best', bestScore.toString());
    }
    
    document.getElementById('final-score').textContent = Math.floor(score);
    document.getElementById('best-score').textContent = bestScore;
    document.getElementById('end-screen').classList.remove('hidden');
}

function updateCamera() {
    // Smooth camera follow
    const targetX = car.x - canvas.width / 2;
    const targetY = car.y - canvas.height / 2;
    
    camera.x += (targetX - camera.x) * 0.1;
    camera.y += (targetY - camera.y) * 0.1;
}

function render() {
    // Clear
    ctx.fillStyle = '#f5f1e8';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Apply camera transform
    ctx.save();
    ctx.translate(-camera.x, -camera.y);
    
    // Draw track
    drawTrack();
    
    // Draw tire marks
    ctx.strokeStyle = 'rgba(42, 42, 42, 0.3)';
    ctx.lineWidth = 3;
    tireMarks.forEach(mark => {
        ctx.globalAlpha = mark.alpha;
        ctx.save();
        ctx.translate(mark.x, mark.y);
        ctx.rotate(mark.angle);
        ctx.beginPath();
        ctx.moveTo(-5, 0);
        ctx.lineTo(5, 0);
        ctx.stroke();
        ctx.restore();
    });
    ctx.globalAlpha = 1;
    
    // Draw cones
    cones.forEach(cone => {
        if (!cone.hit) {
            ctx.fillStyle = '#ff6b35';
            ctx.strokeStyle = '#2c2c2c';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cone.x, cone.y, 12, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    });
    
    // Draw car
    drawCar();
    
    ctx.restore();
}

function drawTrack() {
    // Draw track surface
    ctx.strokeStyle = '#2c2c2c';
    ctx.lineWidth = trackWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    ctx.beginPath();
    ctx.moveTo(trackPoints[0].x, trackPoints[0].y);
    for (let i = 1; i < trackPoints.length; i++) {
        ctx.lineTo(trackPoints[i].x, trackPoints[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    
    // Draw track fill
    ctx.strokeStyle = '#e8e4d8';
    ctx.lineWidth = trackWidth - 8;
    
    ctx.beginPath();
    ctx.moveTo(trackPoints[0].x, trackPoints[0].y);
    for (let i = 1; i < trackPoints.length; i++) {
        ctx.lineTo(trackPoints[i].x, trackPoints[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    
    // Draw center line
    ctx.strokeStyle = 'rgba(44, 44, 44, 0.2)';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 10]);
    
    ctx.beginPath();
    ctx.moveTo(trackPoints[0].x, trackPoints[0].y);
    for (let i = 1; i < trackPoints.length; i++) {
        ctx.lineTo(trackPoints[i].x, trackPoints[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
}

function drawCar() {
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);
    
    // Car body - simple 86 coupe silhouette
    ctx.fillStyle = '#2c2c2c';
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 2;
    
    // Main body
    ctx.beginPath();
    ctx.moveTo(-10, -18);
    ctx.lineTo(-10, 10);
    ctx.lineTo(-7, 18);
    ctx.lineTo(7, 18);
    ctx.lineTo(10, 10);
    ctx.lineTo(10, -18);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Windshield
    ctx.fillStyle = '#4a4a4a';
    ctx.beginPath();
    ctx.moveTo(-7, -10);
    ctx.lineTo(-7, -2);
    ctx.lineTo(7, -2);
    ctx.lineTo(7, -10);
    ctx.closePath();
    ctx.fill();
    
    // Hood detail
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -18);
    ctx.lineTo(0, -10);
    ctx.stroke();
    
    ctx.restore();
}

function updateHUD() {
    document.getElementById('time-display').textContent = timeLeft.toFixed(1);
    document.getElementById('score-display').textContent = Math.floor(score);
    document.getElementById('combo-display').textContent = combo > 0 ? `x${combo} COMBO!` : '';
}

function gameLoop() {
    const dt = 1 / 60;
    
    if (gameState === 'playing') {
        // Update timer
        timeLeft -= dt;
        if (timeLeft <= 0) {
            timeLeft = 0;
            endGame();
        }
        
        updateCar(dt);
        updateCamera();
    }
    
    render();
    updateHUD();
    
    requestAnimationFrame(gameLoop);
}

// Start the game
init();
