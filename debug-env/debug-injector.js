/**
 * NTR Toolbox Alpha 调试注入器
 * 
 * 使用方法：
 * 1. 将此代码复制到浏览器的开发者工具控制台中执行
 * 2. 或者创建一个书签，将代码粘贴到 URL 中
 * 3. 脚本会被注入到当前页面中
 */

// 读取脚本文件并注入
(async function() {
    // 检查是否已注入
    if (window._NTRToolBoxInstance) {
        console.log('NTR Toolbox Alpha 已存在');
        return;
    }

    console.log('正在加载 NTR Toolbox Alpha 调试版本...');

    // 模拟 Tampermonkey 环境
    const mockGM = {
        openInTab: function(url) {
            window.open(url, '_blank');
        }
    };
    window.GM_openInTab = mockGM.openInTab;

    // 读取脚本内容
    try {
        // 在控制台运行时，需要手动提供脚本内容
        // 这里提供一个最小化的初始化版本
        console.log('NTR Toolbox Alpha 调试注入器已就绪');
        console.log('请在 Tampermonkey 中添加脚本或手动注入完整代码');
    } catch (e) {
        console.error('加载失败:', e);
    }
})();

// 常用调试函数
window.NTRDebug = {
    // 打印所有模块信息
    printModules: function() {
        if (window.script && window.script.configuration) {
            console.log('=== NTR Toolbox Alpha 模块列表 ===');
            window.script.configuration.modules.forEach((mod, i) => {
                console.log(`${i + 1}. ${mod.name} (${mod.type})`);
                if (mod.settings) {
                    mod.settings.forEach(s => {
                        console.log(`   - ${s.name}: ${s.value}`);
                    });
                }
            });
        } else {
            console.log('脚本未加载');
        }
    },

    // 执行指定模块
    runModule: function(moduleName) {
        if (window.script && window.script.configuration) {
            const mod = window.script.configuration.modules.find(m => m.name === moduleName);
            if (mod) {
                window.script.handleModuleClick(mod, null);
                console.log(`已执行模块: ${moduleName}`);
            } else {
                console.error(`未找到模块: ${moduleName}`);
            }
        } else {
            console.error('脚本未加载');
        }
    },

    // 查看 localStorage 数据
    printStorage: function() {
        console.log('=== NTR Toolbox Alpha 存储数据 ===');
        ['workspace-sakura', 'gpt-workspace', 'NTR_ToolBox_Config', 'NTR_KeepState', 'ntr-panel-position'].forEach(key => {
            const data = localStorage.getItem(key);
            if (data) {
                try {
                    console.log(`${key}:`, JSON.parse(data));
                } catch {
                    console.log(`${key}: ${data}`);
                }
            }
        });
    },

    // 清空所有数据
    clearAll: function() {
        ['workspace-sakura', 'gpt-workspace', 'NTR_ToolBox_Config', 'NTR_KeepState', 'ntr-panel-position'].forEach(key => {
            localStorage.removeItem(key);
        });
        console.log('已清空所有 NTR Toolbox Alpha 数据');
    },

    // 模拟页面类型
    mockPage: function(type) {
        console.log(`模拟页面类型: ${type}`);
        // 这里可以添加页面类型模拟逻辑
    }
};

console.log('%c NTR Toolbox Alpha 调试工具已加载 ', 'background: #4ade80; color: #000; font-size: 14px; padding: 5px;');
console.log('使用 NTRDebug.printModules() 查看模块');
console.log('使用 NTRDebug.runModule("模块名称") 执行模块');
console.log('使用 NTRDebug.printStorage() 查看存储');
console.log('使用 NTRDebug.clearAll() 清空数据');