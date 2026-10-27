require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(cookieParser());

// --- MONGODB CONNECTION CACHE (Serverless safe) ---
let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
    if (cachedDb) return cachedDb;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI environment variable is missing.');
    
    const client = new MongoClient(uri, { maxPoolSize: 10 });
    await client.connect();
    const dbName = process.env.MONGODB_DB_NAME || 'lumident_dental';
    const db = client.db(dbName);
    
    cachedClient = client;
    cachedDb = db;

    // Idempotent initialization
    await initializeDatabase(db);
    return db;
}

async function initializeDatabase(db) {
    // Unique index to strictly prevent double bookings at the database level
    await db.collection('appointments').createIndex(
        { appointmentDate: 1, startTime: 1, dentistId: 1 }, 
        { unique: true, partialFilterExpression: { status: { $in: ['pending', 'confirmed'] } } }
    ).catch(() => {}); // Catch if already exists slightly differently

    // Seed Admin if provided via Environment Variables
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD_HASH) {
        await db.collection('admins').updateOne(
            { email: process.env.ADMIN_EMAIL },
            { $set: { 
                email: process.env.ADMIN_EMAIL, 
                passwordHash: process.env.ADMIN_PASSWORD_HASH,
                role: 'admin', isActive: true, updatedAt: new Date()
            }, $setOnInsert: { createdAt: new Date() } },
            { upsert: true }
        );
    }

    // Seed Treatments
    const treatmentCount = await db.collection('treatments').countDocuments();
    if (treatmentCount === 0) {
        await db.collection('treatments').insertMany([
            { name: 'General Dentistry', description: 'Comprehensive dental checkups and basic care.', price: 800, durationMinutes: 30, isActive: true },
            { name: 'Teeth Cleaning', description: 'Professional plaque removal and polishing.', price: 1200, durationMinutes: 30, isActive: true },
            { name: 'Teeth Whitening', description: 'Advanced whitening for a brighter smile.', price: 3500, durationMinutes: 60, isActive: true },
            { name: 'Root Canal Treatment', description: 'Expert care for infected or damaged teeth.', price: 4500, durationMinutes: 60, isActive: true },
            { name: 'Braces Consultation', description: 'Orthodontic assessment and planning.', price: 1000, durationMinutes: 30, isActive: true },
            { name: 'Dental Implants Consultation', description: 'Evaluation for permanent tooth replacement.', price: 1500, durationMinutes: 30, isActive: true },
            { name: 'Pediatric Dentistry', description: 'Gentle and friendly care for children.', price: 900, durationMinutes: 30, isActive: true },
            { name: 'Cosmetic Consultation', description: 'Smile makeover planning and advice.', price: 1200, durationMinutes: 30, isActive: true }
        ]);
    }

    // Seed Dentists
    const dentistCount = await db.collection('dentists').countDocuments();
    if (dentistCount === 0) {
        await db.collection('dentists').insertMany([
            { name: 'Dr. Aanya Sharma', specialization: 'General Dentist', bio: 'Expert in preventive care and patient comfort.', imageUrl: 'https://images.unsplash.com/photo-1559839734-2b71ea197ec2?auto=format&fit=crop&w=300&q=80', isActive: true },
            { name: 'Dr. Rohan Mehta', specialization: 'Orthodontic Consultant', bio: 'Specialist in alignment and braces.', imageUrl: 'https://images.unsplash.com/photo-1622253692010-333f2da6031d?auto=format&fit=crop&w=300&q=80', isActive: true },
            { name: 'Dr. Sara Khan', specialization: 'Cosmetic Dentistry Consultant', bio: 'Dedicated to designing perfect smiles.', imageUrl: 'https://images.unsplash.com/photo-1594824436998-d40b243c158b?auto=format&fit=crop&w=300&q=80', isActive: true }
        ]);
    }
}

// --- AUTH MIDDLEWARE ---
const requireAdmin = (req, res, next) => {
    const token = req.cookies.admin_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, process.env.SESSION_SECRET || 'fallback_secret');
        req.admin = decoded;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid session' });
    }
};

// --- PUBLIC API ROUTES ---
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

app.get('/api/treatments', async (req, res) => {
    try {
        const db = await connectToDatabase();
        const treatments = await db.collection('treatments').find({ isActive: true }).toArray();
        res.json(treatments);
    } catch (e) { res.status(500).json({ error: 'Database error' }); }
});

app.get('/api/dentists', async (req, res) => {
    try {
        const db = await connectToDatabase();
        const dentists = await db.collection('dentists').find({ isActive: true }).toArray();
        res.json(dentists);
    } catch (e) { res.status(500).json({ error: 'Database error' }); }
});

app.get('/api/availability', async (req, res) => {
    try {
        const { date, dentistId } = req.query;
        if (!date) return res.status(400).json({ error: 'Date is required' });

        const db = await connectToDatabase();
        const requestedDate = new Date(date);
        const dayOfWeek = requestedDate.getDay();
        
        // Sun = 0. Clinic closed.
        if (dayOfWeek === 0) return res.json([]);

        let startHour = 9, endHour = 20; // 9 AM to 8 PM
        if (dayOfWeek === 6) endHour = 17; // Sat: 9 AM to 5 PM

        const durationMinutes = 30; 
        let slots = [];
        
        // India Time relative check to avoid booking past times today
        const now = new Date();
        const isToday = now.toISOString().split('T')[0] === date;
        const currentHour = now.getUTCHours() + 5 + (now.getUTCMinutes() + 30 >= 60 ? 1 : 0); // Approx IST

        for (let h = startHour; h < endHour; h++) {
            for (let m = 0; m < 60; m += durationMinutes) {
                if (isToday && h <= currentHour) continue; // Skip past slots today
                slots.push(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`);
            }
        }

        const query = { appointmentDate: date, status: { $in: ['pending', 'confirmed'] } };
        if (dentistId) query.dentistId = dentistId;

        const existing = await db.collection('appointments').find(query).toArray();
        const bookedTimes = existing.map(a => a.startTime);

        res.json(slots.filter(slot => !bookedTimes.includes(slot)));
    } catch (e) {
        res.status(500).json({ error: 'Internal error' });
    }
});

app.post('/api/appointments', async (req, res) => {
    try {
        const db = await connectToDatabase();
        const { patientName, phone, email, treatmentId, dentistId, appointmentDate, startTime, reason } = req.body;
        
        if (!patientName || !phone || !treatmentId || !dentistId || !appointmentDate || !startTime) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const treatment = await db.collection('treatments').findOne({ _id: new ObjectId(treatmentId) });
        const dentist = await db.collection('dentists').findOne({ _id: new ObjectId(dentistId) });
        
        if (!treatment || !dentist) return res.status(400).json({ error: 'Invalid selection' });

        const reference = 'LD-' + Math.random().toString(36).substring(2, 8).toUpperCase();

        const appointment = {
            reference, patientName: String(patientName), phone: String(phone), email: email ? String(email) : null,
            treatmentId, treatmentName: treatment.name, dentistId, dentistName: dentist.name,
            appointmentDate, startTime, endTime: null, reason: reason ? String(reason) : '',
            status: 'pending', createdAt: new Date(), updatedAt: new Date()
        };

        await db.collection('appointments').insertOne(appointment);
        res.json({ success: true, reference, appointment });
    } catch (e) {
        if (e.code === 11000) return res.status(409).json({ error: 'Slot already booked. Please choose another time.' });
        res.status(500).json({ error: 'Booking failed. Try again later.' });
    }
});

app.get('/api/appointments/lookup', async (req, res) => {
    try {
        const { reference, phone } = req.query;
        if (!reference || !phone) return res.status(400).json({ error: 'Reference and phone required' });
        
        const db = await connectToDatabase();
        const appointment = await db.collection('appointments').findOne({ reference, phone });
        
        if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
        res.json(appointment);
    } catch (e) { res.status(500).json({ error: 'Lookup failed' }); }
});

// --- ADMIN API ROUTES ---
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const db = await connectToDatabase();
        const admin = await db.collection('admins').findOne({ email, isActive: true });
        
        if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ id: admin._id, email: admin.email }, process.env.SESSION_SECRET || 'fallback_secret', { expiresIn: '8h' });
        res.cookie('admin_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 8 * 3600000 });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Login error' }); }
});

app.post('/api/admin/logout', (req, res) => {
    res.clearCookie('admin_token');
    res.json({ success: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
    res.json({ email: req.admin.email });
});

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
    try {
        const db = await connectToDatabase();
        const todayStr = new Date().toISOString().split('T')[0];
        
        const [todayCount, pendingCount, confirmedCount, upcomingCount, recent] = await Promise.all([
            db.collection('appointments').countDocuments({ appointmentDate: todayStr }),
            db.collection('appointments').countDocuments({ status: 'pending' }),
            db.collection('appointments').countDocuments({ status: 'confirmed' }),
            db.collection('appointments').countDocuments({ appointmentDate: { $gt: todayStr }, status: { $in: ['pending', 'confirmed'] } }),
            db.collection('appointments').find().sort({ createdAt: -1 }).limit(5).toArray()
        ]);
        
        res.json({ todayCount, pendingCount, confirmedCount, upcomingCount, recent });
    } catch (e) { res.status(500).json({ error: 'Dashboard error' }); }
});

app.get('/api/admin/appointments', requireAdmin, async (req, res) => {
    try {
        const db = await connectToDatabase();
        const appointments = await db.collection('appointments').find().sort({ appointmentDate: -1, startTime: -1 }).toArray();
        res.json(appointments);
    } catch (e) { res.status(500).json({ error: 'Error fetching appointments' }); }
});

app.patch('/api/admin/appointments/:id/status', requireAdmin, async (req, res) => {
    try {
        const { status } = req.body;
        const allowed = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];
        if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

        const db = await connectToDatabase();
        await db.collection('appointments').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { status, updatedAt: new Date() } }
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Update failed' }); }
});

// Settings, Treatments, Dentists admin endpoints omitted for brevity but follow standard CRUD pattern.

// --- UI MOUNTING ---
const adminUI = require('./admin.js');
app.use('/admin', adminUI);

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Lumident Dental Studio | A brighter smile begins here.</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
        <script src="https://unpkg.com/lucide@latest"></script>
        <style>
            :root {
                --primary: #6D5EF5; --primary-dark: #4835C9;
                --mint: #8DE8CF; --aqua: #8DE1F5;
                --pink: #FFD3E4; --cream: #FFF9F0;
                --navy: #18213D; --white: #FFFFFF;
                --bg: linear-gradient(135deg, #FFF9F0 0%, #E6E9FF 50%, #E0F7F4 100%);
            }
            * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
            body { background: var(--bg); color: var(--navy); min-height: 100vh; overflow-x: hidden; }
            
            /* Typography */
            h1, h2, h3 { font-weight: 800; letter-spacing: -0.03em; }
            p { line-height: 1.6; color: #4A5568; }
            
            /* Glassmorphism */
            .glass {
                background: rgba(255, 255, 255, 0.6);
                backdrop-filter: blur(16px);
                -webkit-backdrop-filter: blur(16px);
                border: 1px solid rgba(255, 255, 255, 0.8);
                box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.05);
                border-radius: 24px;
            }
            
            /* Claymorphism */
            .clay-btn {
                background: var(--primary); color: var(--white);
                border: none; padding: 14px 28px; border-radius: 28px;
                font-weight: 600; font-size: 1rem; cursor: pointer;
                box-shadow: 6px 6px 12px rgba(109, 94, 245, 0.3),
                            inset 4px 4px 8px rgba(255,255,255,0.2),
                            inset -4px -4px 8px rgba(0,0,0,0.15);
                transition: transform 0.2s, box-shadow 0.2s;
                display: inline-flex; align-items: center; gap: 8px; text-decoration: none;
            }
            .clay-btn:hover {
                transform: translateY(-3px);
                box-shadow: 8px 8px 16px rgba(109, 94, 245, 0.4),
                            inset 4px 4px 8px rgba(255,255,255,0.3),
                            inset -4px -4px 8px rgba(0,0,0,0.15);
            }
            .clay-btn.secondary {
                background: var(--mint); color: var(--navy);
                box-shadow: 6px 6px 12px rgba(141, 232, 207, 0.4), inset 4px 4px 8px rgba(255,255,255,0.4), inset -4px -4px 8px rgba(0,0,0,0.1);
            }

            /* Layout */
            header { position: fixed; top: 0; width: 100%; z-index: 100; padding: 20px 5%; transition: padding 0.3s; }
            header.scrolled { padding: 10px 5%; }
            nav { display: flex; justify-content: space-between; align-items: center; padding: 15px 30px; border-radius: 100px; }
            .logo { font-weight: 800; font-size: 1.5rem; display: flex; align-items: center; gap: 10px; color: var(--primary-dark); }
            .nav-links { display: flex; gap: 30px; align-items: center; }
            .nav-links a { text-decoration: none; color: var(--navy); font-weight: 600; transition: color 0.2s; }
            .nav-links a:hover { color: var(--primary); }
            
            section { padding: 100px 5%; max-width: 1440px; margin: 0 auto; }
            
            /* Hero */
            .hero { display: grid; grid-template-columns: 1fr 1fr; gap: 60px; align-items: center; min-height: 100vh; padding-top: 150px; }
            .hero-text h1 { font-size: 4rem; line-height: 1.1; margin-bottom: 20px; color: var(--navy); }
            .hero-text p { font-size: 1.25rem; margin-bottom: 40px; max-width: 500px; }
            .hero-image { position: relative; border-radius: 40px; overflow: hidden; height: 600px; }
            .hero-image img { width: 100%; height: 100%; object-fit: cover; }
            .floating-card { position: absolute; bottom: 30px; left: -30px; padding: 20px; border-radius: 20px; display: flex; gap: 15px; align-items: center; animation: float 6s ease-in-out infinite; }
            
            /* Grids */
            .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 30px; margin-top: 50px; }
            .card { padding: 30px; text-align: center; transition: transform 0.3s; position: relative; overflow: hidden; }
            .card:hover { transform: translateY(-10px); }
            .card-icon { width: 60px; height: 60px; background: var(--pink); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; color: var(--primary-dark); }
            .price { font-weight: 800; color: var(--primary); font-size: 1.25rem; margin: 15px 0; }

            /* Modal */
            .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(24, 33, 61, 0.4); backdrop-filter: blur(4px); display: none; justify-content: center; align-items: center; z-index: 1000; opacity: 0; transition: opacity 0.3s; }
            .modal-overlay.active { display: flex; opacity: 1; }
            .modal-content { width: 100%; max-width: 600px; padding: 40px; position: relative; max-height: 90vh; overflow-y: auto; }
            .close-btn { position: absolute; top: 20px; right: 20px; background: none; border: none; cursor: pointer; color: var(--navy); }
            
            /* Forms */
            .form-group { margin-bottom: 20px; text-align: left; }
            .form-group label { display: block; margin-bottom: 8px; font-weight: 600; font-size: 0.9rem; }
            .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 12px 16px; border-radius: 12px; border: 1px solid rgba(109, 94, 245, 0.2); background: rgba(255,255,255,0.5); font-size: 1rem; outline: none; transition: border 0.3s; }
            .form-group input:focus, .form-group select:focus { border-color: var(--primary); background: #fff; }
            .slot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 10px; }
            .slot-btn { padding: 10px; border: 1px solid var(--primary); border-radius: 10px; background: transparent; color: var(--primary); cursor: pointer; transition: all 0.2s; }
            .slot-btn.selected { background: var(--primary); color: white; }
            .slot-btn:disabled { opacity: 0.5; cursor: not-allowed; border-color: #ccc; color: #ccc; }

            /* Animations */
            @keyframes float { 0% { transform: translateY(0); } 50% { transform: translateY(-15px); } 100% { transform: translateY(0); } }
            .reveal { opacity: 0; transform: translateY(30px); transition: all 0.8s ease; }
            .reveal.active { opacity: 1; transform: translateY(0); }

            /* Footer */
            footer { background: var(--navy); color: var(--white); padding: 80px 5% 40px; margin-top: 100px; border-radius: 40px 40px 0 0; }
            
            @media (max-width: 1024px) {
                .hero { grid-template-columns: 1fr; padding-top: 120px; }
                .hero-image { height: 400px; }
                .floating-card { left: 20px; }
            }
            @media (max-width: 768px) {
                .nav-links { display: none; }
                .hero-text h1 { font-size: 2.5rem; }
            }
        </style>
    </head>
    <body>

    <header id="header">
        <nav class="glass">
            <div class="logo"><i data-lucide="smile"></i> Lumident</div>
            <div class="nav-links">
                <a href="#treatments">Treatments</a>
                <a href="#dentists">Our Dentists</a>
                <a href="#about">About</a>
                <button class="clay-btn" onclick="openBooking()">Book Appointment</button>
            </div>
        </nav>
    </header>

    <section class="hero">
        <div class="hero-text reveal">
            <h1>Your Smile Deserves Exceptional Care.</h1>
            <p>Modern dentistry, thoughtful care, and a more comfortable experience — all in one place in the heart of Noida.</p>
            <div style="display: flex; gap: 15px;">
                <button class="clay-btn" onclick="openBooking()">Book Your Visit <i data-lucide="arrow-right"></i></button>
                <a href="#treatments" class="clay-btn secondary">Explore Treatments</a>
            </div>
        </div>
        <div class="hero-image reveal">
            <img src="https://images.unsplash.com/photo-1606811841689-23dfddce3e95?auto=format&fit=crop&w=1200&q=80" alt="Modern dental care">
            <div class="glass floating-card">
                <div style="background: var(--mint); padding: 10px; border-radius: 50%;"><i data-lucide="calendar-check"></i></div>
                <div>
                    <h4 style="color: var(--navy);">Easy Online Booking</h4>
                    <p style="font-size: 0.85rem; margin:0;">Schedule at your convenience</p>
                </div>
            </div>
        </div>
    </section>

    <section id="treatments">
        <h2 style="text-align: center; font-size: 2.5rem;" class="reveal">Our Treatments</h2>
        <p style="text-align: center; margin-bottom: 20px;" class="reveal">Indicative pricing shown. Final price depends on clinical assessment.</p>
        <div class="grid" id="treatments-grid">
            <!-- Populated via JS -->
        </div>
    </section>

    <section id="dentists">
        <h2 style="text-align: center; font-size: 2.5rem;" class="reveal">Meet Our Specialists (Demo Profiles)</h2>
        <div class="grid" id="dentists-grid">
            <!-- Populated via JS -->
        </div>
    </section>
    
    <section id="how-it-works" style="background: rgba(255,255,255,0.3); border-radius: 40px; padding: 80px 5%;">
        <h2 style="text-align: center; font-size: 2.5rem;" class="reveal">How Booking Works</h2>
        <div class="grid">
            <div class="card glass reveal">
                <div class="card-icon"><i data-lucide="list"></i></div>
                <h3>1. Choose Treatment</h3>
                <p>Select the service you need from our extensive list.</p>
            </div>
            <div class="card glass reveal" style="transition-delay: 100ms;">
                <div class="card-icon"><i data-lucide="calendar"></i></div>
                <h3>2. Pick a Time</h3>
                <p>Select your preferred dentist, date, and time slot.</p>
            </div>
            <div class="card glass reveal" style="transition-delay: 200ms;">
                <div class="card-icon"><i data-lucide="user"></i></div>
                <h3>3. Your Details</h3>
                <p>Provide contact info to secure your reservation.</p>
            </div>
            <div class="card glass reveal" style="transition-delay: 300ms;">
                <div class="card-icon"><i data-lucide="check-circle"></i></div>
                <h3>4. Confirmation</h3>
                <p>Get your booking reference instantly online.</p>
            </div>
        </div>
    </section>

    <!-- Booking Modal -->
    <div class="modal-overlay" id="bookingModal">
        <div class="glass modal-content">
            <button class="close-btn" onclick="closeBooking()"><i data-lucide="x" size="24"></i></button>
            <h2 style="margin-bottom: 20px;" id="bookingTitle">Book Appointment</h2>
            
            <form id="bookingForm" onsubmit="submitBooking(event)">
                <!-- Step 1 & 2: Selections -->
                <div id="step1">
                    <div class="form-group">
                        <label>Select Treatment</label>
                        <select id="treatmentSelect" required></select>
                    </div>
                    <div class="form-group">
                        <label>Select Dentist (Optional)</label>
                        <select id="dentistSelect" required></select>
                    </div>
                    <button type="button" class="clay-btn" onclick="nextStep(2)" style="width: 100%; justify-content: center;">Continue</button>
                </div>

                <!-- Step 3: Date & Time -->
                <div id="step2" style="display: none;">
                    <div class="form-group">
                        <label>Select Date</label>
                        <input type="date" id="dateSelect" required onchange="loadSlots()">
                    </div>
                    <div class="form-group">
                        <label>Available Slots</label>
                        <div class="slot-grid" id="slotGrid">
                            <p style="grid-column: 1/-1; color: #666;">Please select a date first.</p>
                        </div>
                        <input type="hidden" id="timeSelect" required>
                    </div>
                    <div style="display: flex; gap: 10px;">
                        <button type="button" class="clay-btn secondary" onclick="nextStep(1)">Back</button>
                        <button type="button" class="clay-btn" onclick="validateStep2()" style="flex: 1; justify-content: center;">Continue</button>
                    </div>
                </div>

                <!-- Step 4: Details -->
                <div id="step3" style="display: none;">
                    <div class="form-group">
                        <label>Full Name</label>
                        <input type="text" id="patientName" required maxlength="50">
                    </div>
                    <div class="form-group">
                        <label>Phone Number</label>
                        <input type="tel" id="patientPhone" required pattern="[0-9]{10}" placeholder="10-digit number">
                    </div>
                    <div class="form-group">
                        <label>Email Address (Optional)</label>
                        <input type="email" id="patientEmail">
                    </div>
                    <div class="form-group">
                        <label>Reason for visit (Optional)</label>
                        <textarea id="patientReason" rows="2"></textarea>
                    </div>
                    <div style="display: flex; gap: 10px;">
                        <button type="button" class="clay-btn secondary" onclick="nextStep(2)">Back</button>
                        <button type="submit" class="clay-btn" id="submitBtn" style="flex: 1; justify-content: center;">Confirm Booking</button>
                    </div>
                </div>

                <!-- Step 5: Success -->
                <div id="stepSuccess" style="display: none; text-align: center; padding: 20px 0;">
                    <div style="color: var(--mint); margin-bottom: 20px;"><i data-lucide="check-circle" size="64"></i></div>
                    <h3>Booking Confirmed!</h3>
                    <p style="margin: 15px 0;">Your appointment reference is:</p>
                    <h2 style="color: var(--primary); letter-spacing: 2px; margin-bottom: 20px;" id="refDisplay"></h2>
                    <p style="font-size: 0.9rem; margin-bottom: 20px;" id="summaryDisplay"></p>
                    <button type="button" class="clay-btn" onclick="window.print()" style="margin-bottom: 10px; width: 100%; justify-content: center;"><i data-lucide="printer"></i> Print Summary</button>
                    <button type="button" class="clay-btn secondary" onclick="closeBooking()" style="width: 100%; justify-content: center;">Done</button>
                </div>
            </form>
        </div>
    </div>

    <footer>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 40px; margin-bottom: 40px;">
            <div>
                <h3 style="margin-bottom: 15px; color: var(--mint);">Lumident Dental Studio</h3>
                <p style="color: rgba(255,255,255,0.7);">A brighter smile begins here. (Fictional Clinic)</p>
            </div>
            <div>
                <h4 style="margin-bottom: 15px;">Contact</h4>
                <p style="color: rgba(255,255,255,0.7);">2nd Floor, Pearl Business Plaza<br>Sector 62, Noida, UP 201309</p>
                <p style="color: rgba(255,255,255,0.7); margin-top: 10px;">📞 +91 98765 43210</p>
                <p style="color: rgba(255,255,255,0.7);">✉️ hello@lumident.example</p>
            </div>
            <div>
                <h4 style="margin-bottom: 15px;">Hours</h4>
                <p style="color: rgba(255,255,255,0.7);">Mon - Fri: 9:00 AM - 8:00 PM</p>
                <p style="color: rgba(255,255,255,0.7);">Saturday: 9:00 AM - 5:00 PM</p>
                <p style="color: rgba(255,255,255,0.7);">Sunday: Closed</p>
            </div>
        </div>
        <div style="text-align: center; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 20px; color: rgba(255,255,255,0.5); font-size: 0.9rem;">
            &copy; 2026 Lumident Dental Studio. Demo Application. <a href="/admin" style="color: inherit;">Admin</a>
        </div>
    </footer>

    <script>
        lucide.createIcons();

        // Scroll animations
        const revealElements = document.querySelectorAll('.reveal');
        const scrollObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) entry.target.classList.add('active');
            });
        }, { threshold: 0.1 });
        revealElements.forEach(el => scrollObserver.observe(el));

        // Header glass effect
        window.addEventListener('scroll', () => {
            if (window.scrollY > 50) document.getElementById('header').classList.add('scrolled');
            else document.getElementById('header').classList.remove('scrolled');
        });

        // Initialize Data
        let treatments = [];
        let dentists = [];

        async function initData() {
            try {
                const [tRes, dRes] = await Promise.all([fetch('/api/treatments'), fetch('/api/dentists')]);
                treatments = await tRes.json();
                dentists = await dRes.json();
                renderTreatments();
                renderDentists();
                populateSelects();
            } catch (e) { console.error('Failed to load data', e); }
        }

        function renderTreatments() {
            const grid = document.getElementById('treatments-grid');
            grid.innerHTML = treatments.map(t => \`
                <div class="card glass reveal active">
                    <h3>\${t.name}</h3>
                    <p style="font-size: 0.9rem; margin-top: 10px; height: 45px;">\${t.description}</p>
                    <div class="price">₹\${t.price.toLocaleString('en-IN')}</div>
                    <button class="clay-btn secondary" onclick="openBooking('\${t._id}')" style="width: 100%; justify-content: center;">Book This Service</button>
                </div>
            \`).join('');
        }

        function renderDentists() {
            const grid = document.getElementById('dentists-grid');
            grid.innerHTML = dentists.map(d => \`
                <div class="card glass reveal active" style="padding: 0;">
                    <img src="\${d.imageUrl}" style="width: 100%; height: 250px; object-fit: cover; border-radius: 24px 24px 0 0;" alt="\${d.name}">
                    <div style="padding: 20px;">
                        <h3>\${d.name}</h3>
                        <p style="color: var(--primary); font-weight: 600; margin-bottom: 10px;">\${d.specialization}</p>
                        <p style="font-size: 0.9rem; margin-bottom: 20px;">\${d.bio}</p>
                        <button class="clay-btn secondary" onclick="openBooking(null, '\${d._id}')" style="width: 100%; justify-content: center;">Consult \${d.name.split(' ')[0]}</button>
                    </div>
                </div>
            \`).join('');
        }

        // Booking Logic
        function populateSelects() {
            const tSel = document.getElementById('treatmentSelect');
            const dSel = document.getElementById('dentistSelect');
            tSel.innerHTML = '<option value="">-- Choose Treatment --</option>' + treatments.map(t => \`<option value="\${t._id}">\${t.name}</option>\`).join('');
            dSel.innerHTML = '<option value="">-- Any Available Dentist --</option>' + dentists.map(d => \`<option value="\${d._id}">\${d.name}</option>\`).join('');
            
            // Restrict dates
            const dateInput = document.getElementById('dateSelect');
            const today = new Date();
            // Simple offset for India (+5:30) approx logic for client side min date
            today.setMinutes(today.getMinutes() + 330);
            dateInput.min = today.toISOString().split('T')[0];
        }

        function openBooking(treatmentId = null, dentistId = null) {
            document.getElementById('bookingModal').classList.add('active');
            if (treatmentId) document.getElementById('treatmentSelect').value = treatmentId;
            if (dentistId) document.getElementById('dentistSelect').value = dentistId;
            nextStep(1);
        }
        function closeBooking() {
            document.getElementById('bookingModal').classList.remove('active');
            document.getElementById('bookingForm').reset();
            document.getElementById('slotGrid').innerHTML = '<p style="grid-column: 1/-1; color: #666;">Please select a date first.</p>';
        }

        function nextStep(step) {
            if (step === 2 && !document.getElementById('treatmentSelect').value) return alert('Please select a treatment.');
            document.getElementById('step1').style.display = step === 1 ? 'block' : 'none';
            document.getElementById('step2').style.display = step === 2 ? 'block' : 'none';
            document.getElementById('step3').style.display = step === 3 ? 'block' : 'none';
            document.getElementById('stepSuccess').style.display = step === 4 ? 'block' : 'none';
        }

        async function loadSlots() {
            const date = document.getElementById('dateSelect').value;
            const dentist = document.getElementById('dentistSelect').value;
            if (!date) return;

            const grid = document.getElementById('slotGrid');
            grid.innerHTML = '<p>Loading...</p>';
            document.getElementById('timeSelect').value = '';

            try {
                const res = await fetch(\`/api/availability?date=\${date}&dentistId=\${dentist}\`);
                const slots = await res.json();
                
                if (slots.length === 0) {
                    grid.innerHTML = '<p style="grid-column: 1/-1; color: #d32f2f;">No slots available. Clinic closed or fully booked.</p>';
                    return;
                }

                grid.innerHTML = slots.map(s => \`<button type="button" class="slot-btn" onclick="selectSlot(this, '\${s}')">\${s}</button>\`).join('');
            } catch(e) { grid.innerHTML = '<p style="color: red;">Error loading slots</p>'; }
        }

        function selectSlot(btn, time) {
            document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            document.getElementById('timeSelect').value = time;
        }

        function validateStep2() {
            if (!document.getElementById('dateSelect').value || !document.getElementById('timeSelect').value) {
                return alert('Please select both date and time slot.');
            }
            nextStep(3);
        }

        async function submitBooking(e) {
            e.preventDefault();
            const btn = document.getElementById('submitBtn');
            btn.disabled = true;
            btn.innerHTML = '<i class="lucide-loader"></i> Booking...';

            const payload = {
                treatmentId: document.getElementById('treatmentSelect').value,
                dentistId: document.getElementById('dentistSelect').value || dentists[0]._id, // fallback to first if "Any"
                appointmentDate: document.getElementById('dateSelect').value,
                startTime: document.getElementById('timeSelect').value,
                patientName: document.getElementById('patientName').value,
                phone: document.getElementById('patientPhone').value,
                email: document.getElementById('patientEmail').value,
                reason: document.getElementById('patientReason').value
            };

            try {
                const res = await fetch('/api/appointments', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error);

                document.getElementById('refDisplay').innerText = data.reference;
                const tName = treatments.find(t => t._id === payload.treatmentId)?.name || '';
                document.getElementById('summaryDisplay').innerText = \`\${payload.patientName} | \${tName} | \${payload.appointmentDate} at \${payload.startTime}\`;
                
                nextStep(4);
            } catch (err) {
                alert(err.message || 'Booking failed');
            } finally {
                btn.disabled = false;
                btn.innerHTML = 'Confirm Booking';
            }
        }

        initData();
    </script>
    </body>
    </html>
    `);
});

if (require.main === module) {
    app.listen(3000, () => console.log('Lumident Server running on port 3000'));
}
module.exports = app;
