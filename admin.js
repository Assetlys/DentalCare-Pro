const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Lumident Admin Dashboard</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
        <script src="https://unpkg.com/lucide@latest"></script>
        <style>
            :root {
                --primary: #6D5EF5; --bg: #F4F7FE; --surface: #FFFFFF;
                --text: #2B3674; --text-light: #A3AED0; --border: #E0E5F2;
                --success: #05CD99; --warning: #FFCE20; --danger: #EE5D50;
            }
            * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
            body { background: var(--bg); color: var(--text); height: 100vh; display: flex; overflow: hidden; }
            
            /* Login Screen */
            #loginScreen { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: var(--bg); display: flex; justify-content: center; align-items: center; z-index: 2000; }
            .login-box { background: var(--surface); padding: 40px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.05); width: 100%; max-width: 400px; text-align: center; }
            .input-field { width: 100%; padding: 12px; margin: 10px 0 20px; border: 1px solid var(--border); border-radius: 10px; outline: none; }
            .btn { background: var(--primary); color: white; border: none; padding: 12px 24px; border-radius: 10px; font-weight: 600; cursor: pointer; width: 100%; transition: opacity 0.2s; }
            .btn:hover { opacity: 0.9; }

            /* Dashboard Layout */
            .sidebar { width: 250px; background: var(--surface); border-right: 1px solid var(--border); padding: 30px 20px; display: flex; flex-direction: column; }
            .logo { font-size: 1.5rem; font-weight: 700; color: var(--primary); display: flex; align-items: center; gap: 10px; margin-bottom: 40px; }
            .nav-item { padding: 12px 15px; border-radius: 10px; color: var(--text-light); font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 12px; margin-bottom: 8px; transition: all 0.2s; }
            .nav-item:hover, .nav-item.active { background: var(--primary); color: white; }
            
            .main-content { flex: 1; padding: 40px; overflow-y: auto; }
            .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; }
            
            /* Cards & Tables */
            .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
            .stat-card { background: var(--surface); padding: 25px; border-radius: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.02); }
            .stat-value { font-size: 2rem; font-weight: 700; color: var(--text); margin-top: 10px; }
            
            .table-container { background: var(--surface); border-radius: 20px; padding: 25px; box-shadow: 0 4px 15px rgba(0,0,0,0.02); }
            table { width: 100%; border-collapse: collapse; text-align: left; }
            th { padding: 15px 10px; color: var(--text-light); border-bottom: 1px solid var(--border); font-weight: 600; }
            td { padding: 15px 10px; border-bottom: 1px solid var(--border); }
            
            .badge { padding: 5px 10px; border-radius: 8px; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; }
            .badge.pending { background: rgba(255,206,32,0.2); color: #B38F00; }
            .badge.confirmed { background: rgba(5,205,153,0.2); color: #038C68; }
            .badge.cancelled { background: rgba(238,93,80,0.2); color: #A62920; }

            .action-btn { background: none; border: none; cursor: pointer; color: var(--text-light); margin-right: 10px; }
            .action-btn:hover { color: var(--primary); }

            .hidden { display: none !important; }
        </style>
    </head>
    <body>

    <!-- Login -->
    <div id="loginScreen">
        <div class="login-box">
            <h2 style="margin-bottom: 10px; color: var(--primary);">Admin Login</h2>
            <p style="color: var(--text-light); margin-bottom: 30px;">Secure Access Only</p>
            <form id="loginForm" onsubmit="handleLogin(event)">
                <input type="email" id="email" class="input-field" placeholder="Admin Email" required>
                <input type="password" id="password" class="input-field" placeholder="Password" required>
                <button type="submit" class="btn">Authenticate</button>
                <p id="loginErr" style="color: var(--danger); margin-top: 15px; font-size: 0.9rem;"></p>
            </form>
        </div>
    </div>

    <!-- Dashboard -->
    <aside class="sidebar hidden" id="sidebar">
        <div class="logo"><i data-lucide="shield-check"></i> Admin</div>
        <div class="nav-item active" onclick="switchTab('overview')"><i data-lucide="layout-dashboard"></i> Overview</div>
        <div class="nav-item" onclick="switchTab('appointments')"><i data-lucide="calendar"></i> Appointments</div>
        <div style="flex:1;"></div>
        <div class="nav-item" onclick="handleLogout()" style="color: var(--danger);"><i data-lucide="log-out"></i> Logout</div>
    </aside>

    <main class="main-content hidden" id="mainContent">
        <header class="header">
            <h1 id="pageTitle">Overview</h1>
            <button class="btn" style="width: auto;" onclick="loadData()"><i data-lucide="refresh-cw" style="width:16px; height:16px;"></i> Refresh</button>
        </header>

        <!-- Overview Tab -->
        <div id="tab-overview">
            <div class="stats-grid">
                <div class="stat-card"><div style="color: var(--text-light);">Today's Appointments</div><div class="stat-value" id="statToday">-</div></div>
                <div class="stat-card"><div style="color: var(--text-light);">Pending Requests</div><div class="stat-value" id="statPending">-</div></div>
                <div class="stat-card"><div style="color: var(--text-light);">Confirmed</div><div class="stat-value" id="statConfirmed">-</div></div>
                <div class="stat-card"><div style="color: var(--text-light);">Upcoming</div><div class="stat-value" id="statUpcoming">-</div></div>
            </div>
            <div class="table-container">
                <h3>Recent Activity</h3>
                <table style="margin-top: 20px;" id="recentTable">
                    <thead><tr><th>Ref</th><th>Patient</th><th>Date & Time</th><th>Status</th></tr></thead>
                    <tbody><!-- Loaded via JS --></tbody>
                </table>
            </div>
        </div>

        <!-- Appointments Tab -->
        <div id="tab-appointments" class="hidden">
            <div class="table-container">
                <div style="display:flex; justify-content:space-between; margin-bottom:20px;">
                    <h3>All Appointments</h3>
                    <input type="date" id="filterDate" class="input-field" style="width:200px; margin:0;" onchange="renderAppointments()">
                </div>
                <table>
                    <thead><tr><th>Ref</th><th>Patient & Contact</th><th>Treatment & Provider</th><th>Date & Time</th><th>Status</th><th>Actions</th></tr></thead>
                    <tbody id="appTableBody"></tbody>
                </table>
            </div>
        </div>
    </main>

    <script>
        lucide.createIcons();

        let appointments = [];

        // Auth Check
        async function checkAuth() {
            try {
                const res = await fetch('/api/admin/me');
                if (res.ok) {
                    document.getElementById('loginScreen').classList.add('hidden');
                    document.getElementById('sidebar').classList.remove('hidden');
                    document.getElementById('mainContent').classList.remove('hidden');
                    loadData();
                }
            } catch (e) {}
        }
        checkAuth();

        async function handleLogin(e) {
            e.preventDefault();
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            try {
                const res = await fetch('/api/admin/login', {
                    method: 'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({email, password})
                });
                if (res.ok) {
                    window.location.reload();
                } else {
                    document.getElementById('loginErr').innerText = 'Invalid credentials';
                }
            } catch(err) { document.getElementById('loginErr').innerText = 'Server error'; }
        }

        async function handleLogout() {
            await fetch('/api/admin/logout', {method: 'POST'});
            window.location.reload();
        }

        function switchTab(tab) {
            document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
            event.currentTarget.classList.add('active');
            
            document.getElementById('tab-overview').classList.add('hidden');
            document.getElementById('tab-appointments').classList.add('hidden');
            
            document.getElementById('tab-' + tab).classList.remove('hidden');
            document.getElementById('pageTitle').innerText = tab.charAt(0).toUpperCase() + tab.slice(1);
        }

        async function loadData() {
            try {
                const [dashRes, appRes] = await Promise.all([
                    fetch('/api/admin/dashboard'), fetch('/api/admin/appointments')
                ]);
                const dash = await dashRes.json();
                appointments = await appRes.json();
                
                // Populate Dashboard
                document.getElementById('statToday').innerText = dash.todayCount;
                document.getElementById('statPending').innerText = dash.pendingCount;
                document.getElementById('statConfirmed').innerText = dash.confirmedCount;
                document.getElementById('statUpcoming').innerText = dash.upcomingCount;

                document.getElementById('recentTable').querySelector('tbody').innerHTML = dash.recent.map(a => \`
                    <tr>
                        <td style="font-family: monospace;">\${a.reference}</td>
                        <td>\${escapeHTML(a.patientName)}</td>
                        <td>\${a.appointmentDate} \${a.startTime}</td>
                        <td><span class="badge \${a.status}">\${a.status}</span></td>
                    </tr>
                \`).join('');

                renderAppointments();
            } catch (e) { alert('Failed to load data.'); }
        }

        function renderAppointments() {
            const filterDate = document.getElementById('filterDate').value;
            const filtered = filterDate ? appointments.filter(a => a.appointmentDate === filterDate) : appointments;
            
            document.getElementById('appTableBody').innerHTML = filtered.map(a => \`
                <tr>
                    <td style="font-family: monospace; font-size: 0.9rem;">\${a.reference}</td>
                    <td>
                        <div style="font-weight: 600;">\${escapeHTML(a.patientName)}</div>
                        <div style="font-size: 0.8rem; color: var(--text-light);">\${escapeHTML(a.phone)}</div>
                    </td>
                    <td>
                        <div>\${a.treatmentName}</div>
                        <div style="font-size: 0.8rem; color: var(--text-light);">\${a.dentistName}</div>
                    </td>
                    <td style="white-space: nowrap;">\${a.appointmentDate}<br>\${a.startTime}</td>
                    <td><span class="badge \${a.status}">\${a.status}</span></td>
                    <td style="white-space: nowrap;">
                        \${a.status === 'pending' ? \`<button class="action-btn" onclick="updateStatus('\${a._id}', 'confirmed')" title="Confirm"><i data-lucide="check" size="18"></i></button>\` : ''}
                        \${a.status === 'confirmed' ? \`<button class="action-btn" onclick="updateStatus('\${a._id}', 'completed')" title="Complete"><i data-lucide="flag" size="18"></i></button>\` : ''}
                        \${['pending', 'confirmed'].includes(a.status) ? \`<button class="action-btn" onclick="updateStatus('\${a._id}', 'cancelled')" title="Cancel"><i data-lucide="x-circle" size="18"></i></button>\` : ''}
                    </td>
                </tr>
            \`).join('');
            lucide.createIcons();
        }

        async function updateStatus(id, status) {
            if(!confirm(\`Change appointment status to \${status}?\`)) return;
            try {
                const res = await fetch(\`/api/admin/appointments/\${id}/status\`, {
                    method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({status})
                });
                if(res.ok) loadData();
            } catch(e) { alert('Update failed'); }
        }

        function escapeHTML(str) {
            if (!str) return '';
            return str.replace(/[&<>'"]/g, tag => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
            }[tag]));
        }
    </script>
    </body>
    </html>
    `);
});

module.exports = router;
