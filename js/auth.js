(function () {
    const ACCESS_KEY = 'ledger_access_token';
    const REFRESH_KEY = 'ledger_refresh_token';
    const USER_KEY = 'ledger_user';

    function getAccessToken() {
        return localStorage.getItem(ACCESS_KEY) || '';
    }

    function getRefreshToken() {
        return localStorage.getItem(REFRESH_KEY) || '';
    }

    function getUser() {
        try {
            return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
        } catch (_error) {
            return null;
        }
    }

    function setSession(payload) {
        if (payload?.access_token) localStorage.setItem(ACCESS_KEY, payload.access_token);
        if (payload?.refresh_token) localStorage.setItem(REFRESH_KEY, payload.refresh_token);
        if (payload?.user) localStorage.setItem(USER_KEY, JSON.stringify(payload.user));
    }

    async function refreshSession() {
        const refreshToken = getRefreshToken();
        if (!refreshToken) return false;

        const response = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refreshToken })
        });

        if (!response.ok) {
            clearSession();
            return false;
        }

        const payload = await response.json();
        setSession(payload);
        return true;
    }

    function clearSession() {
        localStorage.removeItem(ACCESS_KEY);
        localStorage.removeItem(REFRESH_KEY);
        localStorage.removeItem(USER_KEY);
    }

    async function authorizedFetch(url, options = {}) {
        const opts = { ...options, headers: { ...(options.headers || {}) } };
        const token = getAccessToken();
        if (token) opts.headers.Authorization = `Bearer ${token}`;

        let response = await fetch(url, opts);
        if (response.status !== 401) return response;

        const refreshed = await refreshSession();
        if (!refreshed) return response;

        const retryOpts = { ...options, headers: { ...(options.headers || {}) } };
        retryOpts.headers.Authorization = `Bearer ${getAccessToken()}`;
        response = await fetch(url, retryOpts);
        return response;
    }

    async function fetchMe() {
        const response = await authorizedFetch('/api/auth/me');
        if (!response.ok) return null;
        const payload = await response.json();
        if (payload?.user) localStorage.setItem(USER_KEY, JSON.stringify(payload.user));
        return payload?.user || null;
    }

    async function requireAuth({ role, redirectTo = 'login.html' } = {}) {
        let token = getAccessToken();
        if (!token) {
            const refreshed = await refreshSession();
            if (!refreshed) {
                const destination = role ? `${redirectTo}?reason=admin_required` : redirectTo;
                window.location.href = destination;
                return null;
            }
            token = getAccessToken();
        }

        const user = await fetchMe();
        if (!user) {
            clearSession();
            const destination = role ? `${redirectTo}?reason=admin_required` : redirectTo;
            window.location.href = destination;
            return null;
        }

        if (role) {
            const roles = user.roles || [];
            const required = Array.isArray(role) ? role : [role];
            const ok = required.some((r) => roles.includes(r));
            if (!ok) {
                window.location.href = `login.html?reason=admin_required`;
                return null;
            }
        }

        return user;
    }

    window.ledgerAuth = {
        getAccessToken,
        getRefreshToken,
        getUser,
        setSession,
        refreshSession,
        clearSession,
        authorizedFetch,
        fetchMe,
        requireAuth
    };
})();
