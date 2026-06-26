# MediaHarvest

MediaHarvest é um par **extensão de navegador + servidor (backend)** para baixar vídeos e áudios de várias plataformas usando [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) e [`ffmpeg`](https://ffmpeg.org/).

- A **extensão** (Chrome/Edge/Firefox) injeta botões de download direto no X/Twitter, Instagram e em qualquer página que tenha um player de vídeo `<video>`. Também tem um popup para configurar o servidor e a pasta de destino.
- O **backend** (Node.js + Express) recebe a URL, chama o `yt-dlp` para baixar e devolve o arquivo. Ele pode rodar **na mesma máquina** que o navegador ou **em outra máquina da rede** (ex.: um Orange Pi, Raspberry Pi, NAS ou servidor).

---

## Índice

- [Como funciona](#como-funciona)
- [Formatos de download](#formatos-de-download)
- [Pré-requisitos](#pré-requisitos)
- [Parte 1 — Instalar a extensão no navegador](#parte-1--instalar-a-extensão-no-navegador)
- [Parte 2 — Rodar o backend](#parte-2--rodar-o-backend)
  - [Opção A — Local, sem servidor (na sua própria máquina)](#opção-a--local-sem-servidor-na-sua-própria-máquina)
  - [Opção B — Em segundo plano com PM2 (terminal)](#opção-b--em-segundo-plano-com-pm2-terminal)
  - [Opção C — Docker (linha de comando)](#opção-c--docker-linha-de-comando)
  - [Opção D — Docker via Portainer](#opção-d--docker-via-portainer)
- [Parte 3 — Conectar a extensão ao backend](#parte-3--conectar-a-extensão-ao-backend)
  - [Backend na mesma máquina](#backend-na-mesma-máquina)
  - [Backend em outra máquina pela rede (mesmo IP)](#backend-em-outra-máquina-pela-rede-mesmo-ip)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Atualizar o projeto](#atualizar-o-projeto)
- [Mexer / personalizar](#mexer--personalizar)
- [Solução de problemas](#solução-de-problemas)
- [Licença](#licença)

---

## Como funciona

```
┌─────────────────────────┐         HTTP          ┌──────────────────────────┐
│  Navegador + Extensão    │  ──── POST / ───────▶ │  Backend (Node/Express)  │
│  (X, Instagram, vídeos)  │                       │   chama o yt-dlp/ffmpeg  │
│                          │ ◀── /status, /file ── │   baixa o arquivo        │
└─────────────────────────┘                       └──────────────────────────┘
```

1. Você clica em um botão de download (no popup ou injetado na página).
2. A extensão envia a URL atual para o backend (`POST /`).
3. O backend baixa o vídeo com `yt-dlp` numa pasta temporária e informa o progresso (`GET /status/:id`).
4. Quando termina, o navegador baixa o arquivo pronto do backend (`GET /file/:id`) e o backend apaga o temporário.

Endpoints do backend: `GET /health`, `POST /`, `GET /status/:id`, `GET /file/:id`, `POST /open` (abrir pasta — só Windows).

## Formatos de download

| Botão       | O que faz                                                                 |
|-------------|---------------------------------------------------------------------------|
| **Original**| Melhor qualidade de vídeo+áudio disponível (`bv*+ba/b`).                   |
| **WhatsApp**| MP4 menor que ~20 MB quando possível, fácil de compartilhar.               |
| **MP3**     | Só o áudio, convertido para MP3 com capa e metadados embutidos.           |

---

## Pré-requisitos

Depende de **como** você vai rodar o backend:

- **Docker (Opção C/D):** só precisa do [Docker](https://docs.docker.com/get-docker/) (e opcionalmente [Portainer](https://www.portainer.io/)). O `yt-dlp` e o `ffmpeg` já vão dentro da imagem — **você não instala nada disso na sua máquina**.
- **Local / PM2 (Opção A/B):** precisa instalar manualmente:
  - [Node.js 18+](https://nodejs.org) (já vem com o `npm`)
  - [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
  - [`ffmpeg`](https://ffmpeg.org/)

Para usar a extensão você precisa de um navegador baseado em Chromium (Chrome, Edge, Brave) ou Firefox.

---

## Parte 1 — Instalar a extensão no navegador

A extensão é carregada de forma "desempacotada" (não está na loja).

### Chrome / Edge / Brave

1. Baixe/clone este repositório (veja o passo de clone na [Parte 2](#parte-2--rodar-o-backend)).
2. Abra `chrome://extensions` (no Edge: `edge://extensions`).
3. Ative o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** (*Load unpacked*).
5. Selecione a pasta do projeto (a que contém o `manifest.json`).
6. O ícone do **Media Harvest** vai aparecer na barra do navegador.

### Firefox

1. Abra `about:debugging#/runtime/this-firefox`.
2. Clique em **Carregar extensão temporária…** (*Load Temporary Add-on*).
3. Selecione o arquivo `manifest.json` da pasta do projeto.

> No Firefox a extensão fica ativa só até fechar o navegador (carregamento temporário). No Chrome ela permanece.

---

## Parte 2 — Rodar o backend

Primeiro, clone o repositório:

```bash
git clone https://github.com/coradini1/MediaHarvest.git
cd MediaHarvest
```

Agora escolha **uma** das opções abaixo.

### Opção A — Local, sem servidor (na sua própria máquina)

Ideal para quem só quer usar no próprio PC, sem Docker e sem outra máquina.

1. Instale o `yt-dlp` e o `ffmpeg` (veja [pré-requisitos](#pré-requisitos)) e confirme:

   ```bash
   node --version
   yt-dlp --version
   ffmpeg -version
   ```

2. Instale as dependências do projeto:

   ```bash
   npm install
   ```

3. Inicie o backend:

   ```bash
   npm start
   ```

   Você verá: `Server running on http://localhost:3000`.

4. Teste se está no ar (em outro terminal):

   ```bash
   curl http://localhost:3000/health
   # {"status":"ok"}
   ```

O servidor fica rodando **enquanto o terminal estiver aberto**. Feche o terminal e ele para. Para deixá-lo sempre ligado em segundo plano, use a Opção B (PM2) ou a Opção C/D (Docker).

> No modo local, a "pasta de destino" configurada na extensão é onde os vídeos serão salvos. Veja a [Parte 3](#parte-3--conectar-a-extensão-ao-backend).

### Opção B — Em segundo plano com PM2 (terminal)

O [PM2](https://pm2.keymetrics.io/) mantém o backend rodando em segundo plano e reinicia sozinho se cair. Ele já vem como dependência do projeto.

```bash
npm install                              # se ainda não fez
npx pm2 start backend/media.js --name mediaharvest
```

Comandos úteis do PM2:

```bash
npx pm2 status                 # ver se está rodando
npx pm2 logs mediaharvest      # ver logs ao vivo
npx pm2 restart mediaharvest   # reiniciar (ex.: depois de atualizar)
npx pm2 stop mediaharvest      # parar
npx pm2 delete mediaharvest    # remover do PM2
```

Para iniciar automaticamente quando a máquina ligar:

```bash
npx pm2 startup     # siga o comando que ele imprime na tela
npx pm2 save        # salva a lista de processos atual
```

> Você pode definir a pasta de saída e a porta com variáveis de ambiente antes do `pm2 start`. Veja [Variáveis de ambiente](#variáveis-de-ambiente).

### Opção C — Docker (linha de comando)

Não precisa instalar Node, yt-dlp nem ffmpeg na máquina — só o Docker. A imagem já traz tudo.

```bash
docker compose up -d --build
```

Isso:
- Constrói a imagem (Node 20 + ffmpeg + yt-dlp).
- Sobe o container `mediaharvest` na porta **3000**.
- Reinicia sozinho (`restart: unless-stopped`).
- Salva os downloads na pasta `./downloads` do projeto (mapeada para `/downloads` dentro do container).

Teste:

```bash
curl http://localhost:3000/health
```

Comandos úteis:

```bash
docker compose logs -f         # ver logs
docker compose restart         # reiniciar
docker compose down            # parar e remover o container
docker compose up -d --build   # reconstruir depois de atualizar o código
```

### Opção D — Docker via Portainer

Ótimo para rodar num Orange Pi / Raspberry Pi / NAS / servidor pela interface web do Portainer.

1. No Portainer, vá em **Stacks → Add stack**.
2. Dê um nome (ex.: `mediaharvest`).
3. Em **Build method**, use uma destas abordagens:

   **a) Repository (recomendado)** — aponte para este repositório Git e deixe o `docker-compose.yml` ser usado automaticamente.

   **b) Web editor** — cole o conteúdo abaixo:

   ```yaml
   services:
     mediaharvest:
       build: .
       container_name: mediaharvest
       restart: unless-stopped
       environment:
         PORT: 3000
         DOWNLOAD_DIR: /downloads
       ports:
         - "3000:3000"
       volumes:
         - ./downloads:/downloads
   ```

   > A opção `build: .` exige que o Portainer tenha acesso aos arquivos do projeto (use o método **Repository**). Se preferir só rodar uma imagem já construída, troque `build: .` por `image: SEU_USUARIO/mediaharvest` e publique a imagem antes.

4. Clique em **Deploy the stack**.
5. Teste a partir de qualquer máquina da rede:

   ```bash
   curl http://IP_DO_SERVIDOR:3000/health
   ```

---

## Parte 3 — Conectar a extensão ao backend

Abra o popup da extensão (clique no ícone do **Media Harvest**). Há dois campos:

- **Servidor** — o endereço do backend.
- **Pasta de destino** — para onde salvar (opcional no Docker).

### Backend na mesma máquina

- **Servidor:** `http://localhost:3000` (já é o padrão).
- **Pasta de destino:** o caminho onde salvar os arquivos, ex.:
  - Windows: `C:\Users\SeuNome\Downloads`
  - Linux/macOS: `/home/seunome/Downloads`

Clique em **Confirmar servidor** e em **Salvar** (pasta). Pronto.

### Backend em outra máquina pela rede (mesmo IP)

Esse é o cenário do Orange Pi / servidor: o backend roda numa máquina e o navegador em outra, **na mesma rede**.

1. Descubra o IP da máquina que roda o backend (ex.: `192.168.0.50`):
   - Linux: `hostname -I` ou `ip a`
   - Windows: `ipconfig`
2. No popup da extensão, em **Servidor**, informe:

   ```
   http://192.168.0.50:3000
   ```

   (troque pelo IP real do seu servidor) e clique em **Confirmar servidor**.
3. **Pasta de destino:** no modo Docker pode deixar em branco / `/downloads`. O backend baixa temporariamente no servidor e o **navegador baixa o arquivo pronto** automaticamente para a pasta de Downloads do seu PC.

Confirme que o backend está acessível pela rede:

```bash
curl http://192.168.0.50:3000/health
```

> **Não acessa pela rede?** Verifique se a porta **3000** está liberada no firewall da máquina do servidor e se ambas as máquinas estão na mesma rede. O botão **Abrir pasta** do popup só funciona quando o backend roda no **Windows**.

---

## Variáveis de ambiente

O backend lê estas variáveis (todas opcionais):

| Variável        | Padrão     | Descrição                                                                                   |
|-----------------|------------|---------------------------------------------------------------------------------------------|
| `PORT`          | `3000`     | Porta em que o backend escuta.                                                               |
| `DOWNLOAD_DIR`  | *(vazio)*  | Se definida, **força** todos os downloads para esta pasta, ignorando a pasta da extensão. É o que o Docker usa (`/downloads`). |
| `YT_DLP_PATH`   | `yt-dlp`   | Caminho do executável do `yt-dlp` (útil se não estiver no `PATH`).                            |

Exemplos:

```bash
# Linux/macOS — rodar na porta 8080 salvando tudo em /mnt/midia
PORT=8080 DOWNLOAD_DIR=/mnt/midia npm start
```

```powershell
# Windows PowerShell
$env:PORT=8080; $env:DOWNLOAD_DIR="D:\Midia"; npm start
```

No Docker, defina-as no bloco `environment:` do `docker-compose.yml`.

---

## Atualizar o projeto

1. Baixe a versão nova do código:

   ```bash
   git pull
   ```

2. Aplique conforme o modo que você usa:

   - **Local:** `npm install` e rode `npm start` de novo.
   - **PM2:** `npm install` e depois `npx pm2 restart mediaharvest`.
   - **Docker (CLI):** `docker compose up -d --build`.
   - **Docker (Portainer):** na stack, use **Pull and redeploy** (ou **Update the stack** com *re-pull/rebuild* marcado).

3. **Atualizar o `yt-dlp`** (importante — sites mudam e quebram o download):
   - **Local:** `yt-dlp -U` (ou reinstale via pip: `python3 -m pip install -U yt-dlp`).
   - **Docker:** reconstrua a imagem (`docker compose up -d --build`), pois o `yt-dlp` é instalado no build.

4. **Atualizar a extensão:** depois do `git pull`, vá em `chrome://extensions` e clique no botão de **recarregar** (🔄) no card da extensão.

---

## Mexer / personalizar

Estrutura dos arquivos:

| Arquivo               | Para que serve                                                              |
|-----------------------|----------------------------------------------------------------------------|
| `manifest.json`       | Configuração da extensão (permissões, scripts, popup).                     |
| `index.html` / `style.css` / `main.js` | Popup da extensão (interface e lógica de configuração). |
| `app.js`              | Content script: injeta os botões no X, Instagram e em players de vídeo.    |
| `background.js`       | Service worker: acompanha o progresso e dispara o download final no navegador. |
| `backend/media.js`    | Servidor Express que chama o `yt-dlp`/`ffmpeg`. **Toda a lógica de download está aqui.** |
| `Dockerfile`          | Imagem Docker do backend (Node + ffmpeg + yt-dlp).                          |
| `docker-compose.yml`  | Stack pronta para Docker/Portainer.                                         |

Ajustes comuns:

- **Mudar a qualidade/formato dos downloads:** edite a função `executeYtDlp` e o bloco de `format` em `backend/media.js` (são strings de formato do `yt-dlp`, ex.: `bv*+ba/b`).
- **Suportar mais sites:** o `yt-dlp` já suporta centenas de sites. Para injetar botões customizados em um site novo, edite os injetores em `app.js` (`injectTwitterButtons`, `injectInstagramButtons`, `injectNativeVideoButtons`). Para download genérico, a opção **Original** do popup já funciona em qualquer página suportada pelo `yt-dlp`.
- **Mudar o visual do popup:** `index.html` + `style.css`.

Depois de mexer no código da extensão, **recarregue-a** em `chrome://extensions`. Depois de mexer no backend, **reinicie** o backend (ou `pm2 restart` / `docker compose up -d --build`).

---

## Solução de problemas

- **"Erro ao conectar backend" na extensão** → o backend não está no ar ou o **Servidor** está errado. Teste `curl http://SEU_IP:3000/health`.
- **Funciona em `localhost` mas não pela rede** → libere a porta `3000` no firewall do servidor e confirme que as máquinas estão na mesma rede.
- **Download falha em um site específico** → atualize o `yt-dlp` (veja [Atualizar](#atualizar-o-projeto)). Sites mudam com frequência.
- **MP3 sem áudio ou sem conversão** → confirme que o `ffmpeg` está instalado (`ffmpeg -version`). No Docker já vem incluso.
- **Botão "Abrir pasta" não faz nada** → ele só funciona quando o backend roda no **Windows**.

---

## Licença

Este projeto é licenciado sob a Licença MIT — consulte o arquivo [LICENSE](LICENSE) para mais detalhes.
