function registerAccessRoutes(app, deps) {
    const {
        pgPool,
        authLimiter,
        requireAuth,
        requireRole,
        requireVerifiedOwner,
        validateRegisterPayload,
        validateLoginPayload,
        validateRestaurantPayload,
        validateQrCampaignPayload,
        validateVerificationRequestPayload,
        toSafeString,
        hashPassword,
        verifyPassword,
        getUserRoles,
        createSessionTokens,
        hashToken,
        encodeQrPayload,
        signQrToken,
        verifyQrToken,
        ADMIN_BOOTSTRAP_KEY
    } = deps;

    app.post('/api/auth/register', authLimiter, validateRegisterPayload, async (req, res) => {
        const client = await pgPool.connect();
        try {
            const { email, password, display_name, role } = req.body;
            const existing = await client.query(`SELECT user_id FROM users WHERE email = $1`, [email]);
            if (existing.rowCount > 0) {
                return res.status(409).json({ error: 'Email already registered' });
            }

            const passwordHash = hashPassword(password);
            await client.query('BEGIN');

            const userResult = await client.query(`
                INSERT INTO users (email, password_hash, display_name, is_active, created_at, updated_at)
                VALUES ($1, $2, $3, TRUE, NOW(), NOW())
                RETURNING user_id, email, display_name, verification_status, created_at
            `, [email, passwordHash, display_name || null]);
            const user = userResult.rows[0];

            await client.query(`
                INSERT INTO user_roles (user_id, role_id)
                SELECT $1, role_id FROM roles WHERE role_name = $2
                ON CONFLICT DO NOTHING
            `, [user.user_id, role]);

            await client.query(`
                INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
                VALUES ($1, 'auth.register', 'user', $2, $3::jsonb)
            `, [user.user_id, user.user_id, JSON.stringify({ role })]);

            await client.query('COMMIT');

            const roles = await getUserRoles(user.user_id);
            const tokens = await createSessionTokens(user, roles, req);

            return res.status(201).json({
                success: true,
                user: {
                    user_id: user.user_id,
                    email: user.email,
                    display_name: user.display_name,
                    verification_status: user.verification_status,
                    roles
                },
                ...tokens
            });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Auth register error:', error);
            return res.status(500).json({ error: 'Failed to register user' });
        } finally {
            client.release();
        }
    });

    app.post('/api/auth/login', authLimiter, validateLoginPayload, async (req, res) => {
        try {
            const { email, password } = req.body;
            const userResult = await pgPool.query(`
                SELECT user_id, email, password_hash, display_name, is_active, verification_status
                FROM users
                WHERE email = $1
                LIMIT 1
            `, [email]);

            if (userResult.rowCount === 0) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            const user = userResult.rows[0];
            if (!user.is_active) {
                return res.status(403).json({ error: 'Account is disabled' });
            }

            const passwordOk = verifyPassword(password, user.password_hash);
            if (!passwordOk) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            const roles = await getUserRoles(user.user_id);
            const tokens = await createSessionTokens(user, roles, req);

            await pgPool.query(`
                UPDATE users
                SET last_login_at = NOW(), updated_at = NOW()
                WHERE user_id = $1
            `, [user.user_id]);

            return res.json({
                success: true,
                user: {
                    user_id: user.user_id,
                    email: user.email,
                    display_name: user.display_name,
                    verification_status: user.verification_status,
                    roles
                },
                ...tokens
            });
        } catch (error) {
            console.error('Auth login error:', error);
            return res.status(500).json({ error: 'Failed to login' });
        }
    });

    app.post('/api/auth/refresh', authLimiter, async (req, res) => {
        try {
            const refreshToken = toSafeString(req.body?.refresh_token || '', 500);
            if (!refreshToken) {
                return res.status(400).json({ error: 'refresh_token is required' });
            }

            const refreshTokenHash = hashToken(refreshToken);
            const sessionResult = await pgPool.query(`
                SELECT s.session_id, s.user_id, s.expires_at, s.is_revoked,
                       u.email, u.display_name, u.is_active, u.verification_status
                FROM auth_sessions s
                JOIN users u ON u.user_id = s.user_id
                WHERE s.refresh_token_hash = $1
                LIMIT 1
            `, [refreshTokenHash]);

            if (sessionResult.rowCount === 0) {
                return res.status(401).json({ error: 'Invalid refresh token' });
            }

            const session = sessionResult.rows[0];
            if (session.is_revoked || new Date(session.expires_at) <= new Date()) {
                return res.status(401).json({ error: 'Refresh token expired or revoked' });
            }
            if (!session.is_active) {
                return res.status(403).json({ error: 'Account is disabled' });
            }

            await pgPool.query(`
                UPDATE auth_sessions
                SET is_revoked = TRUE, revoked_at = NOW()
                WHERE session_id = $1
            `, [session.session_id]);

            const roles = await getUserRoles(session.user_id);
            const tokens = await createSessionTokens(session, roles, req);

            return res.json({
                success: true,
                user: {
                    user_id: session.user_id,
                    email: session.email,
                    display_name: session.display_name,
                    verification_status: session.verification_status,
                    roles
                },
                ...tokens
            });
        } catch (error) {
            console.error('Auth refresh error:', error);
            return res.status(500).json({ error: 'Failed to refresh session' });
        }
    });

    app.post('/api/auth/logout', async (req, res) => {
        try {
            const refreshToken = toSafeString(req.body?.refresh_token || '', 500);
            if (refreshToken) {
                await pgPool.query(`
                    UPDATE auth_sessions
                    SET is_revoked = TRUE, revoked_at = NOW()
                    WHERE refresh_token_hash = $1
                `, [hashToken(refreshToken)]);
            }
            return res.json({ success: true });
        } catch (error) {
            console.error('Auth logout error:', error);
            return res.status(500).json({ error: 'Failed to logout' });
        }
    });

    app.get('/api/auth/me', requireAuth, async (req, res) => {
        try {
            const userResult = await pgPool.query(`
                SELECT user_id, email, display_name, is_active, verification_status
                FROM users
                WHERE user_id = $1
                LIMIT 1
            `, [req.auth.sub]);

            if (userResult.rowCount === 0 || !userResult.rows[0].is_active) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const user = userResult.rows[0];
            const roles = await getUserRoles(user.user_id);

            return res.json({
                user: {
                    user_id: user.user_id,
                    email: user.email,
                    display_name: user.display_name,
                    verification_status: user.verification_status,
                    roles
                }
            });
        } catch (error) {
            console.error('Auth me error:', error);
            return res.status(500).json({ error: 'Failed to fetch user profile' });
        }
    });

    app.get('/api/admin/users', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
        try {
            const result = await pgPool.query(`
                SELECT
                    u.user_id,
                    u.email,
                    u.display_name,
                    u.is_active,
                    u.verification_status,
                    u.created_at,
                    u.last_login_at,
                    COALESCE(ARRAY_AGG(r.role_name) FILTER (WHERE r.role_name IS NOT NULL), '{}') AS roles
                FROM users u
                LEFT JOIN user_roles ur ON ur.user_id = u.user_id
                LEFT JOIN roles r ON r.role_id = ur.role_id
                GROUP BY u.user_id
                ORDER BY u.created_at DESC
                LIMIT 200
            `);
            return res.json({ users: result.rows });
        } catch (error) {
            console.error('Admin users list error:', error);
            return res.status(500).json({ error: 'Failed to list users' });
        }
    });

    app.post('/api/restaurants', requireAuth, requireRole('owner', 'admin', 'superadmin'), validateRestaurantPayload, async (req, res) => {
        const client = await pgPool.connect();
        try {
            const userId = req.auth.sub;
            const { name, city, lga } = req.body;
            await client.query('BEGIN');

            const restaurantResult = await client.query(`
                INSERT INTO restaurants (
                    name, city, lga, verification_status, owner_user_id, created_at, updated_at
                ) VALUES (
                    $1, $2, $3, 'pending', $4, NOW(), NOW()
                )
                RETURNING restaurant_id, name, city, lga, verification_status, created_at
            `, [name, city, lga, userId]);
            const restaurant = restaurantResult.rows[0];

            await client.query(`
                INSERT INTO restaurant_members (restaurant_id, user_id, role)
                VALUES ($1, $2, 'owner')
                ON CONFLICT DO NOTHING
            `, [restaurant.restaurant_id, userId]);

            await client.query(`
                INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
                VALUES ($1, 'restaurant.create', 'restaurant', $2, $3::jsonb)
            `, [userId, String(restaurant.restaurant_id), JSON.stringify({ name, city, lga })]);

            await client.query('COMMIT');
            return res.status(201).json({ success: true, restaurant });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Create restaurant error:', error);
            return res.status(500).json({ error: 'Failed to create restaurant' });
        } finally {
            client.release();
        }
    });

    app.get('/api/restaurants/me', requireAuth, async (req, res) => {
        try {
            const result = await pgPool.query(`
                SELECT
                    r.restaurant_id,
                    r.name,
                    r.city,
                    r.lga,
                    r.verification_status,
                    r.created_at,
                    rm.role AS membership_role,
                    (
                        SELECT COUNT(*)
                        FROM qr_campaigns qc
                        WHERE qc.restaurant_id = r.restaurant_id
                    ) AS campaign_count
                FROM restaurant_members rm
                JOIN restaurants r ON r.restaurant_id = rm.restaurant_id
                WHERE rm.user_id = $1
                ORDER BY r.created_at DESC
            `, [req.auth.sub]);
            return res.json({ restaurants: result.rows });
        } catch (error) {
            console.error('Restaurants me error:', error);
            return res.status(500).json({ error: 'Failed to fetch restaurants' });
        }
    });

    app.post('/api/admin/restaurants/:id/verify', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
        try {
            const restaurantId = toSafeString(req.params.id || '', 80);
            if (!restaurantId) return res.status(400).json({ error: 'restaurant id is required' });

            const result = await pgPool.query(`
                UPDATE restaurants
                SET verification_status = 'verified',
                    verified_at = NOW(),
                    verified_by = $2,
                    updated_at = NOW()
                WHERE restaurant_id = $1
                RETURNING restaurant_id, name, city, lga, verification_status, verified_at
            `, [restaurantId, req.auth.sub]);

            if (result.rowCount === 0) return res.status(404).json({ error: 'Restaurant not found' });
            return res.json({ success: true, restaurant: result.rows[0] });
        } catch (error) {
            console.error('Verify restaurant error:', error);
            return res.status(500).json({ error: 'Failed to verify restaurant' });
        }
    });

    app.post('/api/qr/campaigns', requireAuth, requireRole('owner', 'admin', 'superadmin'), requireVerifiedOwner, validateQrCampaignPayload, async (req, res) => {
        const client = await pgPool.connect();
        try {
            const userId = req.auth.sub;
            const { restaurant_id: restaurantId, campaign_name: campaignName, expires_in_days: expiresInDays } = req.body;

            const accessResult = await client.query(`
                SELECT r.restaurant_id, r.name, r.city, r.lga, r.verification_status, rm.role
                FROM restaurants r
                JOIN restaurant_members rm ON rm.restaurant_id = r.restaurant_id
                WHERE r.restaurant_id = $1 AND rm.user_id = $2
                LIMIT 1
            `, [restaurantId, userId]);

            if (accessResult.rowCount === 0) {
                return res.status(403).json({ error: 'No access to this restaurant' });
            }

            const restaurant = accessResult.rows[0];
            if (restaurant.verification_status !== 'verified') {
                return res.status(403).json({ error: 'Restaurant must be verified before QR campaign creation' });
            }

            const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
            const campaignResult = await client.query(`
                INSERT INTO qr_campaigns (
                    restaurant_id, campaign_name, is_active, created_by, created_at, expires_at
                ) VALUES ($1, $2, TRUE, $3, NOW(), $4)
                RETURNING campaign_id, restaurant_id, campaign_name, created_at, expires_at
            `, [restaurantId, campaignName, userId, expiresAt]);
            const campaign = campaignResult.rows[0];

            const tokenPayload = {
                restaurant_id: String(restaurant.restaurant_id),
                campaign_id: String(campaign.campaign_id),
                exp: expiresAt.getTime()
            };
            const token = encodeQrPayload(tokenPayload);
            const signature = signQrToken(token);
            const publicUrl = `/customer.html?token=${encodeURIComponent(token)}&sig=${encodeURIComponent(signature)}`;

            await client.query(`
                INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
                VALUES ($1, 'qr_campaign.create', 'qr_campaign', $2, $3::jsonb)
            `, [userId, String(campaign.campaign_id), JSON.stringify({ restaurant_id: restaurantId, campaign_name: campaignName })]);

            return res.status(201).json({
                success: true,
                campaign,
                qr: {
                    token,
                    signature,
                    public_url: publicUrl
                },
                restaurant: {
                    restaurant_id: restaurant.restaurant_id,
                    name: restaurant.name,
                    city: restaurant.city,
                    lga: restaurant.lga
                }
            });
        } catch (error) {
            console.error('Create QR campaign error:', error);
            return res.status(500).json({ error: 'Failed to create QR campaign' });
        } finally {
            client.release();
        }
    });

    app.get('/api/qr/resolve', async (req, res) => {
        try {
            const token = toSafeString(req.query?.token || '', 2000);
            const signature = toSafeString(req.query?.sig || req.query?.signature || '', 256);
            const payload = verifyQrToken(token, signature);
            if (!payload) {
                return res.status(400).json({ error: 'Invalid or expired QR token' });
            }

            const result = await pgPool.query(`
                SELECT
                    qc.campaign_id,
                    qc.is_active,
                    qc.expires_at,
                    r.restaurant_id,
                    r.name,
                    r.city,
                    r.lga,
                    r.verification_status
                FROM qr_campaigns qc
                JOIN restaurants r ON r.restaurant_id = qc.restaurant_id
                WHERE qc.campaign_id = $1
                  AND qc.restaurant_id = $2
                LIMIT 1
            `, [payload.campaign_id, payload.restaurant_id]);

            if (result.rowCount === 0) return res.status(404).json({ error: 'QR campaign not found' });
            const row = result.rows[0];
            if (!row.is_active) return res.status(400).json({ error: 'QR campaign is inactive' });
            if (new Date(row.expires_at) <= new Date()) return res.status(400).json({ error: 'QR campaign expired' });

            return res.json({
                campaign_id: row.campaign_id,
                restaurant: {
                    restaurant_id: row.restaurant_id,
                    name: row.name,
                    city: row.city,
                    lga: row.lga,
                    verification_status: row.verification_status
                }
            });
        } catch (error) {
            console.error('Resolve QR token error:', error);
            return res.status(500).json({ error: 'Failed to resolve QR token' });
        }
    });

    app.post('/api/verification/request', requireAuth, validateVerificationRequestPayload, async (req, res) => {
        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');
            const userId = req.auth.sub;
            const payload = req.body;

            const existingPending = await client.query(`
                SELECT verification_id
                FROM verification_requests
                WHERE user_id = $1 AND status = 'pending'
                LIMIT 1
            `, [userId]);
            if (existingPending.rowCount > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'A verification request is already pending review' });
            }

            const requestResult = await client.query(`
                INSERT INTO verification_requests (
                    user_id, entity_type, business_name, city, lga, notes, status, metadata, submitted_at, created_at, updated_at
                ) VALUES (
                    $1, 'user', $2, $3, $4, $5, 'pending', $6::jsonb, NOW(), NOW(), NOW()
                )
                RETURNING verification_id, status, submitted_at
            `, [
                userId,
                payload.business_name,
                payload.city,
                payload.lga,
                payload.notes || null,
                JSON.stringify({})
            ]);

            const verification = requestResult.rows[0];

            for (const doc of payload.documents) {
                await client.query(`
                    INSERT INTO verification_documents (
                        verification_id, document_type, document_ref, metadata
                    ) VALUES ($1, $2, $3, $4::jsonb)
                `, [
                    verification.verification_id,
                    doc.document_type,
                    doc.document_ref,
                    JSON.stringify(doc.metadata || {})
                ]);
            }

            await client.query(`
                UPDATE users
                SET verification_status = 'pending', updated_at = NOW()
                WHERE user_id = $1
            `, [userId]);

            await client.query(`
                INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
                VALUES ($1, 'verification.request', 'verification_request', $2, $3::jsonb)
            `, [userId, String(verification.verification_id), JSON.stringify({ business_name: payload.business_name })]);

            await client.query('COMMIT');

            return res.status(201).json({
                success: true,
                verification_id: verification.verification_id,
                status: verification.status,
                submitted_at: verification.submitted_at
            });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Verification request error:', error);
            return res.status(500).json({ error: 'Failed to submit verification request' });
        } finally {
            client.release();
        }
    });

    app.get('/api/verification/me', requireAuth, async (req, res) => {
        try {
            const userId = req.auth.sub;
            const requestResult = await pgPool.query(`
                SELECT verification_id, business_name, city, lga, notes, status, submitted_at, decided_at, rejection_reason
                FROM verification_requests
                WHERE user_id = $1
                ORDER BY submitted_at DESC
                LIMIT 1
            `, [userId]);

            if (requestResult.rowCount === 0) {
                return res.json({ request: null, documents: [] });
            }

            const request = requestResult.rows[0];
            const docsResult = await pgPool.query(`
                SELECT document_id, document_type, document_ref, metadata, created_at
                FROM verification_documents
                WHERE verification_id = $1
                ORDER BY created_at ASC
            `, [request.verification_id]);

            return res.json({ request, documents: docsResult.rows });
        } catch (error) {
            console.error('Verification me error:', error);
            return res.status(500).json({ error: 'Failed to fetch verification status' });
        }
    });

    app.get('/api/admin/verifications', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
        try {
            const statusFilter = toSafeString(req.query?.status || '', 20).toLowerCase();
            const allowed = ['pending', 'approved', 'rejected'];
            const status = allowed.includes(statusFilter) ? statusFilter : null;

            const baseQuery = `
                SELECT
                    vr.verification_id,
                    vr.user_id,
                    u.email,
                    u.display_name,
                    vr.business_name,
                    vr.city,
                    vr.lga,
                    vr.status,
                    vr.notes,
                    vr.submitted_at,
                    vr.decided_at,
                    vr.rejection_reason,
                    (
                        SELECT COUNT(*)
                        FROM verification_documents vd
                        WHERE vd.verification_id = vr.verification_id
                    ) AS document_count
                FROM verification_requests vr
                JOIN users u ON u.user_id = vr.user_id
            `;

            const result = status
                ? await pgPool.query(baseQuery + ` WHERE vr.status = $1 ORDER BY vr.submitted_at DESC LIMIT 200`, [status])
                : await pgPool.query(baseQuery + ` ORDER BY vr.submitted_at DESC LIMIT 200`);

            return res.json({ requests: result.rows });
        } catch (error) {
            console.error('Admin verifications list error:', error);
            return res.status(500).json({ error: 'Failed to list verification requests' });
        }
    });

    app.post('/api/admin/verifications/:id/approve', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
        const client = await pgPool.connect();
        try {
            const verificationId = toSafeString(req.params.id || '', 120);
            if (!verificationId) {
                return res.status(400).json({ error: 'verification id is required' });
            }

            await client.query('BEGIN');
            const requestResult = await client.query(`
                SELECT verification_id, user_id, status
                FROM verification_requests
                WHERE verification_id = $1
                LIMIT 1
            `, [verificationId]);
            if (requestResult.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Verification request not found' });
            }

            const request = requestResult.rows[0];
            if (request.status === 'approved') {
                await client.query('ROLLBACK');
                return res.json({ success: true, verification_id: request.verification_id, status: 'approved' });
            }

            await client.query(`
                UPDATE verification_requests
                SET status = 'approved',
                    decided_at = NOW(),
                    decided_by = $2,
                    rejection_reason = NULL,
                    updated_at = NOW()
                WHERE verification_id = $1
            `, [verificationId, req.auth.sub]);

            await client.query(`
                UPDATE users
                SET verification_status = 'verified', updated_at = NOW()
                WHERE user_id = $1
            `, [request.user_id]);

            await client.query(`
                INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
                VALUES ($1, 'verification.approve', 'verification_request', $2, $3::jsonb)
            `, [req.auth.sub, verificationId, JSON.stringify({})]);

            await client.query('COMMIT');
            return res.json({ success: true, verification_id: verificationId, status: 'approved' });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Approve verification error:', error);
            return res.status(500).json({ error: 'Failed to approve verification request' });
        } finally {
            client.release();
        }
    });

    app.post('/api/admin/verifications/:id/reject', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
        const client = await pgPool.connect();
        try {
            const verificationId = toSafeString(req.params.id || '', 120);
            const reason = toSafeString(req.body?.reason || req.body?.rejection_reason || '', 500);
            if (!verificationId) {
                return res.status(400).json({ error: 'verification id is required' });
            }
            if (!reason) {
                return res.status(400).json({ error: 'rejection reason is required' });
            }

            await client.query('BEGIN');
            const requestResult = await client.query(`
                SELECT verification_id, user_id
                FROM verification_requests
                WHERE verification_id = $1
                LIMIT 1
            `, [verificationId]);
            if (requestResult.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Verification request not found' });
            }
            const request = requestResult.rows[0];

            await client.query(`
                UPDATE verification_requests
                SET status = 'rejected',
                    decided_at = NOW(),
                    decided_by = $2,
                    rejection_reason = $3,
                    updated_at = NOW()
                WHERE verification_id = $1
            `, [verificationId, req.auth.sub, reason]);

            await client.query(`
                UPDATE users
                SET verification_status = 'rejected', updated_at = NOW()
                WHERE user_id = $1
            `, [request.user_id]);

            await client.query(`
                INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
                VALUES ($1, 'verification.reject', 'verification_request', $2, $3::jsonb)
            `, [req.auth.sub, verificationId, JSON.stringify({ reason })]);

            await client.query('COMMIT');
            return res.json({ success: true, verification_id: verificationId, status: 'rejected' });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Reject verification error:', error);
            return res.status(500).json({ error: 'Failed to reject verification request' });
        } finally {
            client.release();
        }
    });

    app.post('/api/admin/bootstrap-superadmin', authLimiter, async (req, res) => {
        const email = toSafeString(req.body?.email || '', 254).toLowerCase();
        const bootstrapKey = toSafeString(req.body?.bootstrap_key || '', 256);

        if (!ADMIN_BOOTSTRAP_KEY) {
            return res.status(503).json({ error: 'Bootstrap key is not configured' });
        }
        if (!bootstrapKey || bootstrapKey !== ADMIN_BOOTSTRAP_KEY) {
            return res.status(401).json({ error: 'Invalid bootstrap key' });
        }
        if (!email) {
            return res.status(400).json({ error: 'email is required' });
        }

        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');

            const alreadyResult = await client.query(`
                SELECT 1
                FROM user_roles ur
                JOIN roles r ON r.role_id = ur.role_id
                WHERE r.role_name = 'superadmin'
                LIMIT 1
            `);
            if (alreadyResult.rowCount > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Superadmin already assigned' });
            }

            const userResult = await client.query(`
                SELECT user_id, email
                FROM users
                WHERE email = $1
                LIMIT 1
            `, [email]);
            if (userResult.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'User not found' });
            }
            const user = userResult.rows[0];

            await client.query(`
                INSERT INTO user_roles (user_id, role_id)
                SELECT $1, role_id FROM roles WHERE role_name = 'superadmin'
                ON CONFLICT DO NOTHING
            `, [user.user_id]);

            await client.query(`
                INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
                VALUES (NULL, 'admin.bootstrap_superadmin', 'user', $1, $2::jsonb)
            `, [String(user.user_id), JSON.stringify({ email: user.email })]);

            await client.query('COMMIT');
            return res.json({ success: true, user_id: user.user_id, email: user.email, role: 'superadmin' });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Bootstrap superadmin error:', error);
            return res.status(500).json({ error: 'Failed to bootstrap superadmin' });
        } finally {
            client.release();
        }
    });
}

module.exports = registerAccessRoutes;
