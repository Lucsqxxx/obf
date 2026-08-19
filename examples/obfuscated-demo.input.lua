-- UmbraX obfuscation demo: a small Luau exploit-style script
local Players = game:GetService("Players")
local plr = Players.LocalPlayer

local function greet(name)
    return "Hello, " .. name .. "! Welcome to UmbraX."
end

local total = 0
for i = 1, 10 do
    total = total + i * 2
end

getgenv().umbraxDemo = {
    version = "2.3",
    sum = total,
    message = greet(plr and plr.Name or "guest"),
}

print(getgenv().umbraxDemo.message)
print("sum of 2*(1..10) = " .. total)