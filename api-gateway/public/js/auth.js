/**
 * MarkeeAuth — shared client-side auth utility
 * Included on all protected pages. Handles token validation, expiry, and
 * redirecting to /login?next=<current url> when auth is required.
 */
window.MarkeeAuth = (function () {

    function _decode(t) {
        try { return JSON.parse(atob(t.split('.')[1])); }
        catch { return null; }
    }

    /** Returns token string if valid and not expired; null otherwise. */
    function getToken() {
        const t = localStorage.getItem('access_token');
        if (!t) return null;
        const p = _decode(t);
        if (!p) return null;
        if (p.exp && p.exp * 1000 < Date.now()) {
            localStorage.removeItem('access_token');
            localStorage.removeItem('refresh_token');
            return null;
        }
        return t;
    }

    /** Returns decoded JWT payload or null. */
    function getUser() {
        const t = getToken();
        return t ? _decode(t) : null;
    }

    /** Redirects to /login preserving the current URL as ?next= */
    function redirectToLogin() {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.replace('/login?next=' + next);
    }

    /**
     * Validates auth and returns { token, user } or null.
     * If null is returned, a redirect to /login has already been scheduled —
     * callers must stop execution: if (!auth) return;
     */
    function requireAuth() {
        const token = getToken();
        const user  = getUser();
        if (!token || !user) {
            redirectToLogin();
            return null;
        }
        return { token, user };
    }

    /**
     * Call after any fetch response.
     * Returns true if the response was a 401 and a redirect was fired.
     * Caller should return/abort if this returns true.
     */
    function handle401(res) {
        if (res && res.status === 401) {
            localStorage.removeItem('access_token');
            localStorage.removeItem('refresh_token');
            redirectToLogin();
            return true;
        }
        return false;
    }

    return { getToken, getUser, requireAuth, redirectToLogin, handle401 };

}());
