import http.client
import json
import socket

SERVICES = {
    "API Gateway": 4000,
    "Auth Service": 5001,
    "Catalog Service": 5002,
    "Order Service": 5003,
    "Payment Service": 5004,
    "Seller Service": 5005,
    "Inventory Service": 5006,
    "Shipping Service": 5007,
    "Review Service": 5008,
    "Messaging Service": 5009,
    "Notification Service": 5010,
    "Analytics Service": 5011,
    "Search Service": 5012,
    "User Service": 5013,
    "Admin Service": 5014
}

def check_service(name, port):
    conn = http.client.HTTPConnection("localhost", port, timeout=2)
    try:
        conn.request("GET", "/health")
        resp = conn.getresponse()
        data = resp.read().decode()
        status = "UP" if resp.status == 200 else f"ERROR ({resp.status})"
        
        # Parse health data if JSON
        health_info = {}
        try:
            health_info = json.loads(data)
        except:
            pass
            
        return {
            "service": name,
            "port": port,
            "status": status,
            "db": health_info.get("dbState") or health_info.get("status") or "N/A"
        }
    except socket.timeout:
        return {"service": name, "port": port, "status": "TIMEOUT", "db": "N/A"}
    except Exception as e:
        return {"service": name, "port": port, "status": f"DOWN ({str(e)})", "db": "N/A"}
    finally:
        conn.close()

results = []
print(f"{'Service':<20} | {'Port':<5} | {'Status':<15} | {'DB/Health'}")
print("-" * 60)

for name, port in SERVICES.items():
    res = check_service(name, port)
    results.append(res)
    print(f"{res['service']:<20} | {res['port']:<5} | {res['status']:<15} | {res['db']}")

# Write to report file
with open("foundational_docs/to_be_deleted/pulse_check_results.json", "w") as f:
    json.dump(results, f, indent=2)

print(f"\nReport written to foundational_docs/to_be_deleted/pulse_check_results.json")
