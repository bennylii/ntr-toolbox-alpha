# NTR Toolbox Alpha Tampermonkey 调试环境搭建指南

## 方法一：使用 Chrome 开发者工具直接调试

### 步骤 1：安装 Tampermonkey 扩展
1. 打开 Chrome 浏览器
2. 访问 [Tampermonkey 官网](https://www.tampermonkey.net/)
3. 点击 "安装" 按钮添加到 Chrome

### 步骤 2：添加脚本
1. 点击 Tampermonkey 图标
2. 选择 "添加新脚本"
3. 打开 `ntr-toolbox-alpha.user.js` 文件
4. 复制全部内容
5. 粘贴到编辑器中并保存

### 步骤 3：访问目标网站并调试
1. 打开浏览器开发者工具 (F12 或 Ctrl+Shift+I)
2. 访问 https://n.novelia.cc/novel
3. 在 Console 标签页查看脚本日志
4. 在 Sources 标签页找到 Tampermonkey 脚本进行断点调试

---

## 方法二：使用 Violentmonkey（更强大的调试支持）

### 安装 Violentmonkey
1. 访问 Chrome 应用商店搜索 "Violentmonkey"
2. 安装扩展

### 调试功能
- 支持在 Sources 面板中显示用户脚本
- 可以设置断点
- 支持变量查看

---

## 方法三：使用本地服务器 + 脚本注入

### 启动本地服务器
```powershell
# 在项目目录启动
cd c:/cache/models/debug-env
python -m http.server 8080
```

### 在开发者工具中手动注入脚本
1. 打开浏览器开发者工具
2. 切换到 Console 标签
3. 复制 `ntr-toolbox-alpha.user.js` 的内容（去掉 UserScript 头部注释）
4. 粘贴并按回车执行

---

## 调试技巧

### 1. 查看脚本输出
在脚本中使用 `console.log()` 输出调试信息，会显示在浏览器的 Console 中。

### 2. 使用 NotificationUtils
脚本中已经内置了通知功能：
```javascript
NotificationUtils.showSuccess('成功消息');
NotificationUtils.showError('错误消息');
NotificationUtils.showWarning('警告消息');
```

### 3. 断点调试
- 在 Chrome Sources 面板中找到 Tampermonkey 脚本
- 点击行号添加断点
- 触发相应操作后会自动暂停

### 4. 查看 localStorage
在 Console 中执行：
```javascript
console.log(localStorage.getItem('NTR_ToolBox_Config'));
console.log(localStorage.getItem('workspace-sakura'));
```

### 5. 手动触发模块
在 Console 中执行：
```javascript
// 假设脚本已加载
const mod = script.configuration.modules.find(m => m.name === '排隊Sakura v2');
if (mod) script.handleModuleClick(mod, null);
```

---

## 常见问题

### Q: 脚本不加载
A: 检查 Tampermonkey 是否启用，检查 @match 规则是否匹配当前页面

### Q: 无法连接到网站
A: 网站可能需要登录，先登录后再使用脚本

### Q: 调试时脚本不暂停
A: 确保在 Sources 面板中启用了 "Pause on exceptions"

---

## 自动化安装脚本

创建一个 PowerShell 脚本来自动配置调试环境：

```powershell
# 创建 Tampermonkey 配置脚本
$configScript = @"
// ==UserScript==
// @name         NTR Toolbox Alpha Debug
// @namespace    http://tampermonkey.net/
// @version      v0.7.1
// @match        https://n.novelia.cc/*
// @match        https://books.fishhawk.top/*
// @match        https://books1.fishhawk.top/*
// @grant        GM_openInTab
// @run-at       document-start
// ==/UserScript==

// 注入调试代码
console.log('[DEBUG] NTR Toolbox Alpha 加载中...');
"@

Write-Host $configScript
```

---

## 推荐的工作流程

1. **日常调试**：使用 Tampermonkey 在真实网站上调试
2. **功能测试**：使用本地模拟页面测试独立功能
3. **问题复现**：在真实网站上使用脚本，记录错误信息
4. **修复验证**：修改脚本后刷新页面测试

---

如需进一步帮助，请提供具体的错误信息或问题描述。