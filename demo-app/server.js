import express from 'express';

const app = express();
app.use(express.urlencoded({ extended: true }));

const page = (title, body) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${title}</title>
<style>body{font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 16px}
nav a{margin-right:12px}button{padding:8px 16px}input{padding:6px;margin-right:8px}
#result{margin-top:12px;font-weight:700;color:#2a7}</style></head><body>${body}</body></html>`;

const nav = `<nav><a href="/">首页</a><a href="/calc">计算器</a><a href="/about">关于</a></nav>`;

app.get('/', (_req, res) => {
  res.send(page('首页', `${nav}<h1>示例应用</h1>
    <p>一个用于演示验收测试的小应用。</p>
    <a href="/login"><button>登录</button></a>
    <a href="/calc"><button>打开计算器</button></a>`));
});

app.get('/login', (_req, res) => {
  res.send(page('登录', `${nav}<h1>登录</h1>
    <form><input placeholder="用户名"><input placeholder="密码" type="password"><button type="submit">登录</button></form>
    <p>（演示环境，登录逻辑未实现）</p>`));
});

app.get('/calc', (_req, res) => {
  res.send(page('计算器', `${nav}<h1>加法计算器</h1>
    <input id="a" placeholder="数字 A" type="number">
    <input id="b" placeholder="数字 B" type="number">
    <button id="add">计算</button>
    <div id="result"></div>
    <script>
      document.getElementById('add').onclick = () => {
        const a = +document.getElementById('a').value || 0;
        const b = +document.getElementById('b').value || 0;
        document.getElementById('result').textContent = '结果：' + (a + b);
      };
    </script>`));
});

app.get('/about', (_req, res) => {
  res.send(page('关于', `${nav}<h1>关于</h1><p>demo-app v1.0，仅供测试。</p>`));
});

const PORT = process.env.PORT || 4100;
app.listen(PORT, () => console.log(`demo-app: http://localhost:${PORT}`));
