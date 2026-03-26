// Wait for DOM to load
document.addEventListener('DOMContentLoaded', function() {
    
    // ===== LIVE COUNTERS (Simulated for MVP) =====
    function updateLiveCounters() {
        // In production, these come from Firebase
        document.getElementById('totalReports').innerText = Math.floor(2847 + Math.random() * 100);
        document.getElementById('activeUsers').innerText = Math.floor(1203 + Math.random() * 50);
        document.getElementById('alertsSent').innerText = Math.floor(156 + Math.random() * 20);
    }
    
    setInterval(updateLiveCounters, 30000);
    updateLiveCounters();
    
    // ===== ALERT BANNER (Real-time push simulation) =====
    const alerts = [
        "🔴 3 harassment reports in Surulere in last 1hr. Owners alerted.",
        "🟡 Diesel now ₦890/litre in Apapa. 12% spike this week.",
        "🟠 Tomato shortage: 8 Ibadan owners report supplier failure.",
        "🔵 Port Harcourt: Casual staff wage theft reports up 40%.",
        "🟢 Abuja: Power improved in Wuse, 5 owners confirm."
    ];
    
    function rotateAlert() {
        const alertEl = document.getElementById('alertMessage');
        if (!alertEl) return;
        
        let currentIndex = 0;
        setInterval(() => {
            alertEl.innerText = alerts[currentIndex];
            currentIndex = (currentIndex + 1) % alerts.length;
        }, 8000);
    }
    
    rotateAlert();
    
    // ===== SHOW ALERT BANNER =====
    document.querySelector('.alert-banner').classList.add('active');
    
    // ===== CLOSE ALERT =====
    document.querySelector('.alert-close').addEventListener('click', function() {
        document.querySelector('.alert-banner').style.display = 'none';
    });
    
    // ===== LIVE TICKER (Auto-updating) =====
    function updateTicker() {
        const ticker = document.querySelector('.ticker');
        if (!ticker) return;
        
        // In production, fetch from Firebase
        const tickerItems = [
            '<span>🔴 Abuja: KAI raid reported in Wuse 2 • 2min ago</span>',
            '<span>🟡 Lagos: Diesel now ₦870/litre in Apapa • 7min ago</span>',
            '<span>🟠 Ibadan: Tomato price spike, 3 owners report spoilage • 12min ago</span>',
            '<span>🔵 PH: Port Harcourt owners report customer drop 40% • 18min ago</span>',
            '<span>🟢 Kano: Market stable, no major issues reported • 25min ago</span>'
        ];
        
        ticker.innerHTML = tickerItems.join('');
    }
    
    setInterval(updateTicker, 60000);
    updateTicker();
    
    // ===== BUTTON HANDLERS =====
    
    // Owner signup
    const ownerBtn = document.getElementById('ownerSignupBtn');
    if (ownerBtn) {
        ownerBtn.addEventListener('click', function() {
            window.location.href = 'dashboard.html';
        });
    }
    
    // Worker anonymous entry
    const workerBtn = document.getElementById('workerEntryBtn');
    if (workerBtn) {
        workerBtn.addEventListener('click', function() {
            window.location.href = 'worker.html';
        });
    }
    
    // Join diary
    const joinBtn = document.getElementById('joinDiaryBtn');
    if (joinBtn) {
        joinBtn.addEventListener('click', function() {
            window.location.href = 'dashboard.html';
        });
    }
    
    // Share confession
    const shareBtn = document.getElementById('shareConfessionBtn');
    if (shareBtn) {
        shareBtn.addEventListener('click', function() {
            window.location.href = 'confession-wall.html#share';
        });
    }
    
    // City alert buttons
    document.querySelectorAll('.city-alert-btn').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            const city = this.closest('.city-card').querySelector('h3').innerText.split(' ')[0];
            
            // Show browser notification (if permission granted)
            if (Notification.permission === 'granted') {
                new Notification(`🔔 Ledger Alerts: ${city}`, {
                    body: `You'll now receive alerts for ${city}. Configure in dashboard.`,
                    icon: '/assets/icons/logo-icon.png'
                });
            } else if (Notification.permission !== 'denied') {
                Notification.requestPermission();
            }
            
            alert(`✅ You'll now receive alerts for ${city}. We'll notify you via push and SMS.`);
        });
    });
    
    // Request notification permission
    if (Notification.permission === 'default') {
        setTimeout(() => {
            Notification.requestPermission();
        }, 5000);
    }
    
    // ===== MOBILE MENU =====
    const mobileMenuBtn = document.querySelector('.mobile-menu-btn');
    const navbar = document.querySelector('.navbar');
    if (mobileMenuBtn && navbar) {
        mobileMenuBtn.addEventListener('click', function() {
            navbar.classList.toggle('mobile-open');

            // Toggle icon
            const icon = this.querySelector('i');
            if (icon) {
                icon.classList.toggle('fa-bars');
                icon.classList.toggle('fa-times');
            }
        });
    }
    
    // ===== ONE SIGNAL INIT (Push Notifications) =====
    if (window.OneSignal) {
        window.OneSignalDeferred = window.OneSignalDeferred || [];
        OneSignalDeferred.push(function(OneSignal) {
            OneSignal.init({
                appId: "YOUR_ONESIGNAL_APP_ID",
                safari_web_id: "YOUR_SAFARI_WEB_ID",
                notifyButton: {
                    enable: true,
                    size: 'medium',
                    position: 'bottom-right',
                    prenotify: true,
                    showCredit: false,
                    text: {
                        'tip.state.unsubscribed': 'Get live industry alerts',
                        'tip.state.subscribed': 'Alerts enabled',
                        'tip.state.blocked': 'Blocked - enable alerts',
                        'message.prenotify': 'Click to get real-time alerts on diesel, raids & spoilage',
                        'message.action.subscribed': "Thanks! You'll receive live industry alerts.",
                        'message.action.resubscribed': "Alerts re-enabled",
                        'message.action.unsubscribed': "You won't receive alerts"
                    },
                    colors: {
                        'circle.background': '#c7382b',
                        'circle.foreground': 'white',
                        'badge.background': '#0a2647',
                        'badge.bordercolor': 'white',
                        'badge.text': 'white',
                        'button.background': '#c7382b',
                        'button.hover.background': '#a82d22',
                        'button.text': 'white'
                    }
                }
            });
        });
    }
});
