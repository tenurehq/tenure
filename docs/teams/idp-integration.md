# IdP Integration Cookbook

## Overview

Tenure does not implement its own OIDC or SAML login flows. Instead, it lives behind a trusted reverse proxy or gateway inside your VPC. That proxy terminates corporate SSO, then asserts identity via a simple HTTP header.

This guide provides copy-pasteable manifests for three common gateway patterns, followed by SCIM 2.0 connector settings for Okta and Microsoft Entra ID.

## The Contract

Regardless of which proxy you choose, the setup must satisfy three rules:

1. **Strip incoming identity headers at the perimeter.** Your proxy must drop any `x-user-id` header sent by the client before performing SSO, so end users cannot spoof identity.
2. **Assert identity after SSO.** After successful authentication, the proxy must send a header (default is `x-user-id`) to Tenure carrying the trusted user identifier.
3. **Align with SCIM.** The value sent in the identity header must exactly match the `userName` attribute your identity provider pushes via SCIM 2.0. If they diverge, offboarding will fail.

## Before You Start

Configure Tenure to expect the header your proxy will send.

If your proxy sets something other than `x-user-id` (e.g., `x-auth-request-user`), set the corresponding environment variable in the Tenure deployment:

| Variable            | Value                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `TENURE_MODE`       | `teams`                                                                                   |
| `OIDC_PROXY_HEADER` | The lowercase header name your proxy injects (e.g., `x-user-id` or `x-auth-request-user`) |
| `TENURE_SCIM_TOKEN` | A long random bearer token shared with your IdP's SCIM connector                          |

## Option 1: OAuth2 Proxy (Recommended)

OAuth2 Proxy is the fastest path if you already have an OIDC issuer. The examples below assume Microsoft Entra ID. Change `--oidc-issuer-url` for Okta or any other provider.

### Standard approach: `X-Auth-Request-User`

By default, OAuth2 Proxy sets `X-Auth-Request-User` from the OIDC claim. Map Tenure to read it so you do not need alpha configuration.

```yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: oauth2-proxy
  namespace: tenure
spec:
  replicas: 2
  selector:
    matchLabels:
      app: oauth2-proxy
  template:
    metadata:
      labels:
        app: oauth2-proxy
    spec:
      containers:
        - name: oauth2-proxy
          image: quay.io/oauth2-proxy/oauth2-proxy:v7.6.0
          args:
            - --provider=oidc
            - --oidc-issuer-url=https://login.microsoftonline.com/<tenant-id>/v2.0
            - --upstream=http://tenure.tenure.svc.cluster.local:5757
            - --set-xauthrequest=true
            - --pass-access-token=false
            - --pass-authorization-header=false
            - --cookie-secure=true
            - --cookie-samesite=lax
            - --http-address=0.0.0.0:4180
            - --skip-auth-preflight=true
          envFrom:
            - secretRef:
                name: oauth2-proxy-credentials # contains OAUTH2_PROXY_CLIENT_ID, OAUTH2_PROXY_CLIENT_SECRET, OAUTH2_PROXY_COOKIE_SECRET
          ports:
            - containerPort: 4180
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
---
apiVersion: v1
kind: Service
metadata:
  name: oauth2-proxy
  namespace: tenure
spec:
  selector:
    app: oauth2-proxy
  ports:
    - port: 4180
      targetPort: 4180
```

````

Because OAuth2 Proxy is the single point of contact to Tenure, it naturally overwrites any client-sent `X-Auth-Request-User` header on the outbound request.

### Tenure configuration

Set `OIDC_PROXY_HEADER` to the header OAuth2 Proxy actually sends:

```yaml
env:
  - name: TENURE_MODE
    value: "teams"
  - name: OIDC_PROXY_HEADER
    value: "x-auth-request-user"
  - name: TENURE_SCIM_TOKEN
    valueFrom:
      secretKeyRef:
        name: tenure-scim
        key: token
```

### Service-to-service encryption

The manifest above targets Tenure over plaintext HTTP (`tenure.tenure.svc.cluster.local:5757`). If your security posture requires encrypted traffic inside the cluster, deploy Tenure behind Istio (see Option 3) or terminate TLS at a sidecar. The Tenure container itself does not natively listen for TLS.

## Option 2: NGINX Ingress Controller

If you use the NGINX Ingress Controller, delegate authentication to OAuth2 Proxy via authentication annotations. Traffic never reaches Tenure unless the subrequest succeeds.

### Ingress for Tenure

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tenure
  namespace: tenure
  annotations:
    nginx.ingress.kubernetes.io/auth-url: "http://oauth2-proxy.tenure.svc.cluster.local:4180/oauth2/auth"
    nginx.ingress.kubernetes.io/auth-signin: "https://$host/oauth2/start?rd=$escaped_request_uri"
    nginx.ingress.kubernetes.io/auth-response-headers: "X-Auth-Request-User"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      # Ensure the auth response header overwrites anything a client sent.
      proxy_set_header X-Auth-Request-User $auth_header_x_auth_request_user;
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - tenure.example.com
      secretName: tenure-tls
  rules:
    - host: tenure.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: tenure
                port:
                  number: 5757
```

### Ingress for OAuth2 Proxy

You also need an ingress so the browser can reach OAuth2 Proxy's sign-in and callback handlers:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: oauth2-proxy
  namespace: tenure
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - tenure.example.com
      secretName: tenure-tls
  rules:
    - host: tenure.example.com
      http:
        paths:
          - path: /oauth2
            pathType: Prefix
            backend:
              service:
                name: oauth2-proxy
                port:
                  number: 4180
```

### Tenure configuration

Same as Option 1:

```yaml
env:
  - name: OIDC_PROXY_HEADER
    value: "x-auth-request-user"
```

## Option 3: Istio External Authorization

If you run Istio, you can enforce OIDC at the mesh level using an external authorization provider. This keeps Tenure itself unchanged; Istio blocks unauthorized requests before they reach the pod.

### 1. Register the extension provider

Add the following to your Istio mesh config (via IstioOperator or `istio` ConfigMap). This only needs to be done once per cluster:

```yaml
extensionProviders:
  - name: oauth2-proxy
    envoyExtAuthzHttp:
      service: oauth2-proxy.tenure.svc.cluster.local
      port: 4180
      includeHeadersInCheck:
        - authorization
        - cookie
      headersToUpstreamOnAllow:
        - x-auth-request-user
        - x-auth-request-email
      headersToDownstreamOnDeny:
        - set-cookie
```

### 2. Strip client identity headers at the gateway

Before the ext-authz check, remove any identity headers the client may have sent. This EnvoyFilter targets the default ingress gateway. If your gateway is in a different namespace or uses different labels, adjust the `workloadSelector` accordingly.

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: strip-client-identity-headers
  namespace: istio-system
spec:
  workloadSelector:
    labels:
      istio: ingressgateway
  configPatches:
    - applyTo: HTTP_FILTER
      match:
        context: GATEWAY
        listener:
          filterChain:
            filter:
              name: envoy.filters.network.http_connection_manager
      patch:
        operation: INSERT_BEFORE
        value:
          name: envoy.lua
          typedConfig:
            "@type": type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua
            sourceCode:
              inlineString: |
                function envoy_on_request(request_handle)
                  request_handle:headers():remove("x-auth-request-user")
                  request_handle:headers():remove("x-user-id")
                  request_handle:headers():remove("x-forwarded-user")
                end
```

### 3. Gateway

```yaml
apiVersion: networking.istio.io/v1beta1
kind: Gateway
metadata:
  name: tenure-gateway
  namespace: tenure
spec:
  selector:
    istio: ingressgateway
  servers:
    - port:
        number: 443
        name: https
        protocol: HTTPS
      tls:
        mode: SIMPLE
        credentialName: tenure-tls
      hosts:
        - tenure.example.com
```

### 4. AuthorizationPolicy for Tenure

```yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: tenure-oauth
  namespace: tenure
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: tenure
  action: CUSTOM
  provider:
    name: oauth2-proxy
  rules:
    - to:
        - operation:
            hosts: ["tenure.example.com"]
            paths: ["/*"]
```

### 5. VirtualService

```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: tenure
  namespace: tenure
spec:
  hosts:
    - tenure.example.com
  gateways:
    - tenure-gateway
  http:
    - route:
        - destination:
            host: tenure
            port:
              number: 5757
```

### 6. OAuth2 Proxy deployment

Reuse the OAuth2 Proxy manifest from Option 1, but change `--upstream` to a dummy value (Istio routes after auth, not OAuth2 Proxy):

```yaml
args:
  - --upstream=file:///dev/null
  - --set-xauthrequest=true
  # ... other args
```

### 7. Enforce mTLS inside the mesh (optional)

If you want encrypted traffic between OAuth2 Proxy and Tenure pods, enable strict mTLS for the namespace:

```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: tenure-strict
  namespace: tenure
spec:
  mtls:
    mode: STRICT
```

### Tenure configuration

```yaml
env:
  - name: OIDC_PROXY_HEADER
    value: "x-auth-request-user"
```

## SCIM 2.0 Connector Setup

SCIM is how Tenure receives user lifecycle events from your IdP. When an employee is deactivated, the IdP sends a SCIM `PATCH` that Tenure uses to immediately revoke every PAT and terminate every session.

### Okta

In the Okta Admin Console:

| Field                                | Value                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------- |
| SCIM connector base URL              | `https://tenure.example.com/scim/v2`                                      |
| Unique identifier field for users    | `userName`                                                                |
| Authentication mode                  | HTTP Header                                                               |
| Authorization header                 | `Bearer <TENURE_SCIM_TOKEN>`                                              |
| Application username format          | **Email** (or `Okta username`, but must match the value your proxy sends) |
| Update user attributes               | Yes                                                                       |
| Deactivate users                     | Yes                                                                       |
| Import new users and profile updates | As needed                                                                 |

After saving, push a test user and confirm that `userName` in Tenure matches the `x-auth-request-user` header value seen in Tenure's access logs.

### Microsoft Entra ID

In the Azure Portal, open your Enterprise Application provisioning settings:

| Field               | Value                                |
| ------------------- | ------------------------------------ |
| Tenant URL          | `https://tenure.example.com/scim/v2` |
| Secret Token        | `<TENURE_SCIM_TOKEN>`                |
| Provisioning status | On                                   |

Under **Attribute Mapping**, ensure:

| Source attribute    | Target attribute |
| ------------------- | ---------------- |
| `userPrincipalName` | `userName`       |

If your OAuth2 Proxy / Entra ID setup sends `userPrincipalName` (email) as the `x-auth-request-user` claim, this mapping aligns deprovisioning perfectly. If your proxy sends a different claim (e.g., `oid`), change the Entra ID mapping so that the target `userName` matches the proxy claim value.

## Network-Level Restrictions

### Coarse protection with NetworkPolicy

Kubernetes NetworkPolicy is layer 3 and layer 4 only. It cannot filter by HTTP path, but it is still the first control most operators reach for. Restrict the whole Tenure workload so only your ingress controller and known SCIM delivery IPs can reach it.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: tenure-ingress
  namespace: tenure
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: tenure
  policyTypes:
    - Ingress
  ingress:
    # Allow HTTP traffic from the ingress controller namespace
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
      ports:
        - protocol: TCP
          port: 5757
    # Allow SCIM from known IdP egress (coarse; pair with application-layer controls)
    - from:
        - ipBlock:
            cidr: 203.0.113.0/24 # Replace with your IdP's SCIM delivery IPs
      ports:
        - protocol: TCP
          port: 5757
```

### Path-based restriction with Istio

If you use Istio, enforce the SCIM path rule at the application layer:

```yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: scim-path-restriction
  namespace: tenure
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: tenure
  action: ALLOW
  rules:
    # All non-SCIM traffic is allowed (authentication happens in CUSTOM policy above)
    - to:
        - operation:
            notPaths: ["/scim/*", "/scim"]
    # SCIM is allowed only from known IdP IPs
    - to:
        - operation:
            paths: ["/scim/*"]
      when:
        - key: source.ip
          values: ["203.0.113.0/24"]
```

If you do not use Istio, enforce path restrictions at your ingress controller or cloud WAF instead.

## Token Rotation

`TENURE_SCIM_TOKEN` is a long-lived bearer token. Rotate it using your normal secret management pipeline:

1. Generate a new random token.
2. Update the Kubernetes Secret referenced by `TENURE_SCIM_TOKEN`.
3. Trigger a rolling restart of the Tenure deployment (for example, via `kubectl rollout restart` or `helm upgrade`).
4. Once the new pods are live, update the Secret Token field in your IdP SCIM connector.
5. Revoke the old value from the connector console.

There is a brief window during rollout where the IdP may still hold the old token while new pods expect the new one. Most IdPs retry on 401, so a few failed deliveries are normal. If your organization requires zero-downtime rotation with full dual-token overlap, note that Tenure currently accepts only a single SCIM token value.

## Audit Logging for Compliance

Tenure does not emit a dedicated authentication audit log stream. For SOC 2, ISO 27001, or internal reviews, forward your proxy or mesh access logs to your SIEM. Those logs provide the canonical record of who was asserted and when.

Within Tenure, the following audit artifacts are available:

- **`api_tokens.last_used_at`** — Updated on every authenticated PAT request.
- **`api_tokens.revoked_at`** — Set immediately when a token is revoked.
- **`scim_users` collection** — Maintains provisioning state and `lastModified` timestamps for every SCIM-managed identity.
- **`injection_audit` collection** — Records which beliefs were injected into which sessions.

## Security Checklist

- [ ] Strip `x-user-id` (or your chosen header) from all requests at the outermost proxy layer so clients cannot preset it.
- [ ] Match IdP `userName` exactly to the proxy header value. An email in one place and a GUID in the other will break offboarding.
- [ ] Generate `TENURE_SCIM_TOKEN` from a CSPRNG. Store it in a Kubernetes Secret and rotate it through your normal pipeline.
- [ ] Use TLS for every hop: IdP to Proxy, Proxy to Tenure, and for the SCIM endpoint.
- [ ] Do not expose `/scim/v2` to the public internet. Restrict it to your IdP's egress IPs via WAF, Istio AuthorizationPolicy, or ingress ACLs.
- [ ] Verify deprovisioning end-to-end: create a test user, grant a PAT, deactivate the user in your IdP, and confirm that the PAT returns HTTP 403 within seconds.

````
