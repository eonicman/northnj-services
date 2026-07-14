// DIY User Auth System - Shared across all category pages
(function() {
    const API_BASE = '/api';
    let currentUser = null;
    
    // Create auth modal if not exists
    function createAuthModal() {
        if (document.getElementById('diy-auth-modal')) return;
        
        const modal = document.createElement('div');
        modal.id = 'diy-auth-modal';
        modal.className = 'diy-modal-overlay';
        modal.style.cssText = 'display:none;z-index:2000;';
        modal.innerHTML = `
            <div class="diy-modal-content" style="max-width:400px;width:90%;background:#fff;border-radius:12px;padding:2rem;position:relative;">
                <button onclick="closeDIYAuthModal()" style="position:absolute;top:1rem;right:1rem;background:none;border:none;font-size:1.5rem;cursor:pointer;">&times;</button>
                <div id="diy-auth-login">
                    <h3 style="margin-top:0;color:#1a1a2e;">🔐 Sign In</h3>
                    <form onsubmit="handleDIYLogin(event)">
                        <input type="email" name="email" required placeholder="Email" style="width:100%;padding:.6rem;border:1px solid #ddd;border-radius:6px;margin-bottom:.75rem;font-size:.9rem;box-sizing:border-box;">
                        <input type="password" name="password" required placeholder="Password" style="width:100%;padding:.6rem;border:1px solid #ddd;border-radius:6px;margin-bottom:1rem;font-size:.9rem;box-sizing:border-box;">
                        <button type="submit" class="diy-btn diy-btn-primary" style="width:100%;">Sign In</button>
                    </form>
                    <p style="text-align:center;margin-top:1rem;color:#666;font-size:.85rem;">
                        No account? <a href="#" onclick="showDIYRegister()" style="color:#e94560;">Create one</a>
                    </p>
                </div>
                
                <div id="diy-auth-register" style="display:none;">
                    <h3 style="margin-top:0;color:#1a1a2e;">📝 Create Account</h3>
                    <form onsubmit="handleDIYRegister(event)">
                        <input type="text" name="name" placeholder="Your Name" style="width:100%;padding:.6rem;border:1px solid #ddd;border-radius:6px;margin-bottom:.75rem;font-size:.9rem;box-sizing:border-box;">
                        <input type="email" name="email" required placeholder="Email" style="width:100%;padding:.6rem;border:1px solid #ddd;border-radius:6px;margin-bottom:.75rem;font-size:.9rem;box-sizing:border-box;">
                        <input type="password" name="password" required placeholder="Password (6+ chars)" style="width:100%;padding:.6rem;border:1px solid #ddd;border-radius:6px;margin-bottom:1rem;font-size:.9rem;box-sizing:border-box;">
                        <button type="submit" class="diy-btn diy-btn-primary" style="width:100%;">Create Account</button>
                    </form>
                    <p style="text-align:center;margin-top:1rem;color:#666;font-size:.85rem;">
                        Have an account? <a href="#" onclick="showDIYLogin()" style="color:#e94560;">Sign in</a>
                    </p>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        // User menu
        const menu = document.createElement('div');
        menu.id = 'diy-user-menu';
        menu.style.cssText = 'display:none;position:fixed;top:3rem;right:1rem;z-index:1001;background:#fff;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.15);padding:.5rem;min-width:150px;';
        menu.innerHTML = `
            <div id="diy-user-name" style="padding:.5rem;font-weight:600;color:#1a1a2e;border-bottom:1px solid #eee;margin-bottom:.5rem;"></div>
            <a href="#" onclick="showDIYSavedGuides()" style="display:block;padding:.5rem;color:#333;text-decoration:none;font-size:.9rem;">📚 My Library</a>
            <a href="#" onclick="handleDIYLogout()" style="display:block;padding:.5rem;color:#e94560;text-decoration:none;font-size:.9rem;">🚪 Sign Out</a>
        `;
        document.body.appendChild(menu);
    }
    
    // Expose functions globally
    window.showDIYAuthModal = function() {
        createAuthModal();
        document.getElementById('diy-auth-modal').style.display = 'flex';
    };
    
    window.closeDIYAuthModal = function() {
        const modal = document.getElementById('diy-auth-modal');
        if (modal) modal.style.display = 'none';
        window.showDIYLogin();
    };
    
    window.showDIYRegister = function() {
        document.getElementById('diy-auth-login').style.display = 'none';
        document.getElementById('diy-auth-register').style.display = 'block';
    };
    
    window.showDIYLogin = function() {
        document.getElementById('diy-auth-login').style.display = 'block';
        document.getElementById('diy-auth-register').style.display = 'none';
    };
    
    window.handleDIYLogin = function(e) {
        e.preventDefault();
        const form = e.target;
        fetch(`${API_BASE}/user/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: form.email.value,
                password: form.password.value
            })
        })
        .then(r => r.json())
        .then(data => {
            if (data.token) {
                localStorage.setItem('diy_token', data.token);
                currentUser = data.user;
                window.closeDIYAuthModal();
                window.updateDIYAuthUI();
            } else {
                alert(data.error || 'Login failed');
            }
        });
    };
    
    window.handleDIYRegister = function(e) {
        e.preventDefault();
        const form = e.target;
        fetch(`${API_BASE}/user/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: form.name.value,
                email: form.email.value,
                password: form.password.value
            })
        })
        .then(r => r.json())
        .then(data => {
            if (data.token) {
                localStorage.setItem('diy_token', data.token);
                currentUser = data.user;
                window.closeDIYAuthModal();
                window.updateDIYAuthUI();
            } else {
                alert(data.error || 'Registration failed');
            }
        });
    };
    
    window.updateDIYAuthUI = function() {
        const trigger = document.getElementById('auth-trigger');
        const menu = document.getElementById('diy-user-menu');
        
        if (currentUser) {
            if (trigger) trigger.style.display = 'none';
            if (menu) {
                document.getElementById('diy-user-name').textContent = currentUser.name || currentUser.email;
                menu.style.display = 'block';
            }
        } else {
            if (trigger) trigger.style.display = 'block';
            if (menu) menu.style.display = 'none';
        }
    };
    
    window.handleDIYLogout = function() {
        localStorage.removeItem('diy_token');
        currentUser = null;
        window.updateDIYAuthUI();
    };
    
    window.showDIYSavedGuides = function() {
        const token = localStorage.getItem('diy_token');
        if (!token) return;
        
        fetch(`${API_BASE}/user/me`, {
            headers: { 'Authorization': `Bearer ${token}` }
        })
        .then(r => r.json())
        .then(data => {
            const guides = data.user?.saved_guides || [];
            if (guides.length === 0) {
                alert('📚 Your library is empty. Save guides by clicking the bookmark icon!');
            } else {
                const list = guides.map(g => `• ${g.guide_title} (${g.category})`).join('\n');
                alert(`📚 Your Saved Guides:\n\n${list}`);
            }
        });
    };
    
    window.saveDIYGuide = function(guideId, category, guideTitle) {
        const token = localStorage.getItem('diy_token');
        if (!token) {
            window.showDIYAuthModal();
            return;
        }
        
        fetch(`${API_BASE}/user/save-guide`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ guideId, category, guideTitle })
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                const btn = document.querySelector(`[data-guide="${guideId}"]`);
                if (btn) {
                    btn.innerHTML = '✅ Saved';
                    btn.style.background = '#22c55e';
                }
            }
        });
    };
    
    // Check auth on load
    function checkAuth() {
        const token = localStorage.getItem('diy_token');
        if (token) {
            fetch(`${API_BASE}/user/me`, {
                headers: { 'Authorization': `Bearer ${token}` }
            })
            .then(r => r.json())
            .then(data => {
                if (data.user) {
                    currentUser = data.user;
                    window.updateDIYAuthUI();
                }
            })
            .catch(() => localStorage.removeItem('diy_token'));
        }
    }
    
    // Add save buttons to guide cards
    function addSaveButtons() {
        document.querySelectorAll('.diy-card').forEach(card => {
            const titleEl = card.querySelector('h3');
            if (!titleEl || card.querySelector('.save-guide-btn')) return;
            
            const guideTitle = titleEl.textContent.trim();
            const guideId = guideTitle.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            const category = document.querySelector('.diy-section h2')?.textContent?.split(' ')[0]?.toLowerCase() || 'general';
            
            const saveBtn = document.createElement('button');
            saveBtn.className = 'save-guide-btn';
            saveBtn.setAttribute('data-guide', guideId);
            saveBtn.style.cssText = 'position:absolute;top:.75rem;right:.75rem;background:#fff;border:1px solid #ddd;border-radius:6px;padding:.3rem .6rem;font-size:.75rem;cursor:pointer;z-index:10;';
            saveBtn.innerHTML = '🔖 Save';
            saveBtn.onclick = (e) => {
                e.stopPropagation();
                window.saveDIYGuide(guideId, category, guideTitle);
            };
            
            card.style.position = 'relative';
            card.appendChild(saveBtn);
        });
    }
    
    // Init
    document.addEventListener('DOMContentLoaded', function() {
        checkAuth();
        addSaveButtons();
    });
})();
