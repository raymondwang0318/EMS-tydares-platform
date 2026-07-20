import json, urllib.request, urllib.error, sys
T = sys.argv[1]


def me(headers):
    r = urllib.request.Request("http://ems-api:8000/v1/admin/auth/me", headers=headers)
    try:
        resp = urllib.request.urlopen(r, timeout=8)
        return resp.status, json.loads(resp.read()).get("user", {}).get("role")
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:
        return "ERR:" + str(e), None


print("=== Pananora api 容器轉發 ems-api /me（軟模式機制核心）===")
s, role = me({"Authorization": "Bearer " + T})
print("  Bearer service token -> %s role=%s  (期望200 admin=轉發可達+雙軌驗證)" % (s, role))
s, _ = me({})
print("  無憑證               -> %s  (期望401=ems-api 拒；Pananora 軟模式據此 fallback)" % (s,))
