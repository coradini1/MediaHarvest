# MediaHarvest

MediaHarvest e um par **extensao de navegador + servidor (backend)** para baixar videos e audios de varias plataformas usando [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) e [`ffmpeg`](https://ffmpeg.org/).

- A **extensao** (Chrome/Edge/Firefox) injeta botoes de download direto no X/Twitter, Instagram e em qualquer pagina que tenha um player de video `<video>`. Tambem tem um popup para configurar o servidor e a pasta de destino.
- O **backend** (Node.js + Express) recebe a URL, chama o `yt-dlp` para baixar e devolve o arquivo. Ele pode rodar **na mesma maquina** que o navegador ou **em outra maquina da rede** (ex.: Orange Pi, Raspberry Pi, NAS ou servidor).

---

## Indice

- [Como funciona](#como-funciona)
- [Estrutura](#estrutura)
- [Formatos de download](#formatos-de-download)
- [Pre-requisitos](#pre-requisitos)
- [Parte 1 - Instalar a extensao no navegador](#parte-1---instalar-a-extensao-no-navegador)
- [Parte 2 - Rodar o backend](#parte-2---rodar-o-backend)
  - [Opcao A - Local, sem servidor](#opcao-a---local-sem-servidor)
  - [Opcao B - Em segundo plano com PM2](#opcao-b---em-segundo-plano-com-pm2)
  - [Opcao C - Docker](#opcao-c---docker)
  - [Opcao D - Docker via Portainer](#opcao-d---docker-via-portainer)
- [Parte 3 - Conectar a extensao ao backend](#parte-3---conectar-a-extensao-ao-backend)
- [Variaveis de ambiente](#variaveis-de-ambiente)
- [Atualizar o projeto](#atualizar-o-projeto)
- [Mexer / personalizar](#mexer--personalizar)
- [Solucao de problemas](#solucao-de-problemas)
- [Licenca](#licenca)

---

## Como funciona

```text
Navegador + Extensao  ->  Backend Node/Express  ->  yt-dlp/ffmpeg
        POST /        <-  status/file pronto     <-  arquivo baixado
```

1. Voce clica em um botao de download no popup ou injetado na pagina.
2. A extensao envia a URL atual para o backend (`POST /`).
3. O backend baixa o video com `yt-dlp` numa pasta temporaria e informa o progresso (`GET /status/:id`).
4. Quando termina, o navegador baixa o arquivo pronto do backend (`GET /file/:id`) e o backend apaga o temporario.

Endpoints principais: `GET /health`, `POST /`, `GET /status/:id`, `GET /file/:id`, `DELETE /downloads/:id` e `POST /open` (abrir pasta - so Windows).

## Estrutura

```text
MediaHarvest/
├── extension/  # extensao para Chrome, Edge, Brave e Firefox
└── server/     # API Node.js, Dockerfile e docker-compose.yml
```

## Formatos de download

| Botao | O que faz |
| --- | --- |
| **Original** | Melhor qualidade de video+audio disponivel (`bv*+ba/b`). |
| **WhatsApp** | MP4 menor que ~20 MB quando possivel, facil de compartilhar. |
| **MP3** | So o audio, convertido para MP3 com capa e metadados embutidos. |

---

## Pre-requisitos

Depende de **como** voce vai rodar o backend:

- **Docker:** so precisa do [Docker](https://docs.docker.com/get-docker/) e, opcionalmente, [Portainer](https://www.portainer.io/). O `yt-dlp` e o `ffmpeg` ja vao dentro da imagem.
- **Local / PM2:** precisa instalar manualmente:
  - [Node.js 18+](https://nodejs.org)
  - [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
  - [`ffmpeg`](https://ffmpeg.org/)

Para usar a extensao voce precisa de um navegador baseado em Chromium (Chrome, Edge, Brave) ou Firefox.

---

## Parte 1 - Instalar a extensao no navegador

A extensao e carregada de forma desempacotada, pois nao esta publicada na loja.

### Chrome / Edge / Brave

1. Baixe ou clone este repositorio.
2. Abra `chrome://extensions` ou, no Edge, `edge://extensions`.
3. Ative o **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactacao**.
5. Selecione a pasta `extension/`.
6. O icone do **MediaHarvest** vai aparecer na barra do navegador.

### Firefox

1. Abra `about:debugging#/runtime/this-firefox`.
2. Clique em **Carregar extensao temporaria**.
3. Selecione o arquivo `extension/manifest.json`.

No Firefox a extensao fica ativa so ate fechar o navegador.

---

## Parte 2 - Rodar o backend

Primeiro, clone o repositorio:

```bash
git clone https://github.com/coradini1/MediaHarvest.git
cd MediaHarvest
```

Agora escolha **uma** das opcoes abaixo.

### Opcao A - Local, sem servidor

Ideal para quem so quer usar no proprio PC, sem Docker e sem outra maquina.

1. Instale o `yt-dlp` e o `ffmpeg` e confirme:

   ```bash
   node --version
   yt-dlp --version
   ffmpeg -version
   ```

2. Instale as dependencias do backend:

   ```bash
   cd server
   npm install
   ```

3. Inicie o backend:

   ```bash
   npm start
   ```

   Voce vera: `Server running on http://localhost:3000`.

4. Teste se esta no ar:

   ```bash
   curl http://localhost:3000/health
   ```

O servidor fica rodando enquanto o terminal estiver aberto.

### Opcao B - Em segundo plano com PM2

O [PM2](https://pm2.keymetrics.io/) mantem o backend rodando em segundo plano e reinicia sozinho se cair.

```bash
cd server
npm install
npx pm2 start backend/media.js --name mediaharvest
```

Comandos uteis:

```bash
npx pm2 status
npx pm2 logs mediaharvest
npx pm2 restart mediaharvest
npx pm2 stop mediaharvest
npx pm2 delete mediaharvest
```

Para iniciar automaticamente quando a maquina ligar:

```bash
npx pm2 startup
npx pm2 save
```

### Opcao C - Docker

Nao precisa instalar Node, yt-dlp nem ffmpeg na maquina, so o Docker.

```bash
cd server
docker compose up -d --build
```

Isso:

- Constroi a imagem com Node, ffmpeg e yt-dlp.
- Sobe o container na porta `3000`.
- Reinicia sozinho com `restart: unless-stopped`.
- Salva os downloads em `server/downloads/`.

Teste:

```bash
curl http://localhost:3000/health
```

Comandos uteis:

```bash
docker compose logs -f
docker compose restart
docker compose down
docker compose up -d --build
```

### Opcao D - Docker via Portainer

Bom para rodar num Orange Pi, Raspberry Pi, NAS ou servidor pela interface web do Portainer.

1. No Portainer, va em **Stacks > Add stack**.
2. De um nome, por exemplo `mediaharvest`.
3. Em **Build method**, use **Repository** e aponte para este repositorio.
4. Configure o caminho do compose como `server/docker-compose.yml`, se o Portainer pedir.
5. Clique em **Deploy the stack**.
6. Teste a partir de qualquer maquina da rede:

   ```bash
   curl http://IP_DO_SERVIDOR:3000/health
   ```

---

## Parte 3 - Conectar a extensao ao backend

Abra o popup da extensao. Ha dois campos principais:

- **Servidor:** endereco do backend.
- **Pasta de destino:** para onde salvar, opcional no Docker.

### Backend na mesma maquina

- **Servidor:** `http://localhost:3000`.
- **Pasta de destino:** caminho onde salvar os arquivos, por exemplo `C:\Users\SeuNome\Downloads` no Windows ou `/home/seunome/Downloads` no Linux.

Clique em **Confirmar servidor** e em **Salvar**.

### Backend em outra maquina pela rede

1. Descubra o IP da maquina que roda o backend.
2. No popup, informe o servidor neste formato:

   ```text
   http://192.168.0.50:3000
   ```

3. No Docker, a pasta de destino pode ficar vazia ou `/downloads`.

Confirme que o backend esta acessivel pela rede:

```bash
curl http://192.168.0.50:3000/health
```

Se nao acessar pela rede, verifique firewall, porta `3000` e se as maquinas estao na mesma rede.

---

## Variaveis de ambiente

O backend le estas variaveis:

| Variavel | Padrao | Descricao |
| --- | --- | --- |
| `PORT` | `3000` | Porta em que o backend escuta. |
| `DOWNLOAD_DIR` | vazio | Se definida, forca todos os downloads para esta pasta, ignorando a pasta da extensao. |
| `YT_DLP_PATH` | `yt-dlp` | Caminho do executavel do `yt-dlp`. |
| `MAX_CONCURRENT_DOWNLOADS` | `2` | Numero maximo de downloads simultaneos. |

Exemplo no Linux/macOS:

```bash
PORT=8080 DOWNLOAD_DIR=/mnt/midia npm start
```

Exemplo no Windows PowerShell:

```powershell
$env:PORT=8080; $env:DOWNLOAD_DIR="D:\Midia"; npm start
```

No Docker, defina as variaveis no bloco `environment:` do `server/docker-compose.yml`.

---

## Atualizar o projeto

1. Baixe a versao nova do codigo:

   ```bash
   git pull
   ```

2. Aplique conforme o modo usado:

- **Local:** em `server/`, rode `npm install` e `npm start`.
- **PM2:** em `server/`, rode `npm install` e `npx pm2 restart mediaharvest`.
- **Docker CLI:** em `server/`, rode `docker compose up -d --build`.
- **Portainer:** use **Pull and redeploy** ou atualize a stack reconstruindo a imagem.

3. Atualize o `yt-dlp` quando sites quebrarem:

- **Local:** `yt-dlp -U` ou reinstale via pip.
- **Docker:** reconstrua a imagem com `docker compose up -d --build`.

4. Depois de atualizar a extensao, va em `chrome://extensions` e clique em recarregar no card dela.

---

## Mexer / personalizar

| Arquivo | Para que serve |
| --- | --- |
| `extension/manifest.json` | Configuracao da extensao. |
| `extension/index.html`, `extension/style.css`, `extension/main.js` | Popup da extensao. |
| `extension/app.js` | Content script que injeta os botoes. |
| `extension/background.js` | Service worker que acompanha progresso e dispara o download final. |
| `server/backend/media.js` | Servidor Express e logica de download. |
| `server/Dockerfile` | Imagem Docker do backend. |
| `server/docker-compose.yml` | Stack pronta para Docker/Portainer. |

Ajustes comuns:

- **Mudar qualidade/formato:** edite a logica de formato em `server/backend/media.js`.
- **Suportar mais sites:** edite os injetores em `extension/app.js`.
- **Mudar o visual do popup:** edite `extension/index.html` e `extension/style.css`.

Depois de mexer no codigo da extensao, recarregue-a em `chrome://extensions`. Depois de mexer no backend, reinicie o servidor.

---

## Solucao de problemas

- **Erro ao conectar backend:** o backend nao esta no ar ou o servidor configurado esta errado. Teste `curl http://SEU_IP:3000/health`.
- **Funciona em localhost mas nao pela rede:** libere a porta `3000` no firewall e confirme que as maquinas estao na mesma rede.
- **Download falha em um site especifico:** atualize o `yt-dlp`.
- **MP3 sem audio ou sem conversao:** confirme que o `ffmpeg` esta instalado. No Docker ja vem incluso.
- **Botao Abrir pasta nao faz nada:** ele so funciona quando o backend roda no Windows.

---

## Licenca

Este projeto e licenciado sob a Licenca MIT. Consulte o arquivo [LICENSE](LICENSE) para mais detalhes.
