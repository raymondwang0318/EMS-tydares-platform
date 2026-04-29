"""T-S11C-001 AC 4: /admin/ir-devices endpoints UT.

GET /v1/admin/ir-devices — list 811c_* + LEFT JOIN metadata
PUT /v1/admin/ir-devices/{device_id}/label — upsert metadata

Note: 完整 async DB fixture 需 testcontainers + asyncpg；本檔記錄 UT design + smoke
case，container 無 pytest 套件未實際跑（M-PM-065 §四例外條款；container 無 pytest
package；UT code 留 commit 軌跡 + 後續 sprint 補 fixture）。

Test cases (4 mandated by M-PM-074 §3.3):
- A: GET 無 metadata → list n row（trx_reading 內 distinct 數量）含 null display_name
- B: PUT upsert 1 顆 → GET 該顆 display_name 正確
- C: PUT upsert 2 次同 device_id → updated_at 第 2 次較新
- D: PUT 非 811c_* prefix → 422 守門
"""

from datetime import datetime, timezone

# 預期 fixture（async DB session）— 後續 sprint 補
# from httpx import AsyncClient


# ===== UT design pattern（給 future sprint 補 fixture 用）=====

async def test_list_ir_devices_no_metadata(async_client, sample_trx_811c_data):
    """A: trx_reading 有 1+ 顆 811c_* 但 ems_ir_device_metadata 全空。

    預期：list 該顆 row；display_name=None；last_seen 為 trx_reading MAX(ts)。
    """
    response = await async_client.get(
        "/v1/admin/ir-devices",
        headers={"Authorization": "Bearer CHANGE_ME"},
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data) >= 1
    for d in data:
        assert d["device_id"].startswith("811c_")
        assert d["display_name"] is None
        assert d["last_seen"] is not None


async def test_upsert_ir_label_then_get(async_client, sample_trx_811c_data):
    """B: PUT 1 顆 display_name → GET 該顆顯示新 name。"""
    device_id = "811c_test-mac"
    new_name = "農技大樓 IR-1"
    put_resp = await async_client.put(
        f"/v1/admin/ir-devices/{device_id}/label",
        json={"display_name": new_name},
        headers={"Authorization": "Bearer CHANGE_ME"},
    )
    assert put_resp.status_code == 200
    assert put_resp.json()["display_name"] == new_name
    assert put_resp.json()["device_id"] == device_id

    # GET list confirms
    get_resp = await async_client.get(
        "/v1/admin/ir-devices",
        headers={"Authorization": "Bearer CHANGE_ME"},
    )
    matched = [d for d in get_resp.json() if d["device_id"] == device_id]
    assert len(matched) == 1
    assert matched[0]["display_name"] == new_name


async def test_upsert_ir_label_twice_updated_at_advances(async_client, sample_trx_811c_data):
    """C: PUT 2 次同 device_id → updated_at 第 2 次 > 第 1 次。"""
    device_id = "811c_test-mac"
    first = await async_client.put(
        f"/v1/admin/ir-devices/{device_id}/label",
        json={"display_name": "first"},
        headers={"Authorization": "Bearer CHANGE_ME"},
    )
    first_ts = datetime.fromisoformat(first.json()["updated_at"])

    # 等待 1 秒避免 NOW() 解析度問題
    import asyncio
    await asyncio.sleep(1)

    second = await async_client.put(
        f"/v1/admin/ir-devices/{device_id}/label",
        json={"display_name": "second"},
        headers={"Authorization": "Bearer CHANGE_ME"},
    )
    second_ts = datetime.fromisoformat(second.json()["updated_at"])

    assert second_ts > first_ts
    assert second.json()["display_name"] == "second"  # 確認 ON CONFLICT update 生效


async def test_upsert_ir_label_non_811c_prefix_returns_422(async_client):
    """D: PUT 非 811c_* prefix → 422 守門。"""
    response = await async_client.put(
        "/v1/admin/ir-devices/cpm12d-TYDARES-E66-slave1/label",
        json={"display_name": "wrong"},
        headers={"Authorization": "Bearer CHANGE_ME"},
    )
    assert response.status_code == 422
    assert "must start with '811c_'" in response.json()["detail"]


async def test_upsert_ir_label_invalid_display_name_type_returns_422(async_client):
    """守門：display_name 非 string/None → 422。"""
    response = await async_client.put(
        "/v1/admin/ir-devices/811c_test-mac/label",
        json={"display_name": 123},
        headers={"Authorization": "Bearer CHANGE_ME"},
    )
    assert response.status_code == 422


async def test_upsert_ir_label_null_display_name_clears(async_client):
    """null display_name 視為清除（保留 row 但 display_name=NULL）。"""
    device_id = "811c_test-mac"
    # First set
    await async_client.put(
        f"/v1/admin/ir-devices/{device_id}/label",
        json={"display_name": "old"},
        headers={"Authorization": "Bearer CHANGE_ME"},
    )
    # Clear
    response = await async_client.put(
        f"/v1/admin/ir-devices/{device_id}/label",
        json={"display_name": None},
        headers={"Authorization": "Bearer CHANGE_ME"},
    )
    assert response.status_code == 200
    assert response.json()["display_name"] is None
