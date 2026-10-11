import Foundation
import Security

func reply(_ value: [String: Any], _ code: Int32 = 0) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data)
    }
    exit(code)
}
var input = Data()
while let chunk = try? FileHandle.standardInput.read(upToCount: 4096), !chunk.isEmpty {
    input.append(chunk)
    if input.count > 65536 { reply(["error": "Invalid secure credential request."], 1) }
}
guard let value = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
      let action = value["action"] as? String,
      let owner = value["owner"] as? String,
      owner.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
    reply(["error": "Invalid secure credential request."], 1)
}
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "com.codeboom.google-drive",
    kSecAttrAccount as String: owner
]
switch action {
case "read":
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { reply(["value": NSNull()]) }
    guard status == errSecSuccess, let data = result as? Data,
          data.count <= 24576, let stored = String(data: data, encoding: .utf8) else {
        reply(["error": "Secure Drive credential store is unavailable."], 1)
    }
    reply(["value": stored])
case "write":
    guard let stored = value["value"] as? String, let data = stored.data(using: .utf8),
          data.count > 0, data.count <= 24576 else {
        reply(["error": "Invalid secure credential request."], 1)
    }
    let changes = [kSecValueData as String: data]
    var status = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
    if status == errSecItemNotFound {
        var create = query
        create[kSecValueData as String] = data
        create[kSecAttrLabel as String] = "Codeboom Google Drive connection"
        status = SecItemAdd(create as CFDictionary, nil)
    }
    guard status == errSecSuccess else { reply(["error": "Secure Drive credential store is unavailable."], 1) }
    reply(["ok": true])
case "clear":
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        reply(["error": "Secure Drive credential store is unavailable."], 1)
    }
    reply(["ok": true])
default:
    reply(["error": "Invalid secure credential request."], 1)
}
