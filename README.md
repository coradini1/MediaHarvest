# MediaHarvest

MediaHarvest é uma extensão desenvolvida para baixar vídeos de diversas plataformas usando yt-dlp. Esta extensão é capaz de baixar vídeos de diferentes sites suportados, proporcionando uma maneira conveniente de armazenar seus vídeos favoritos localmente.

## Pré-requisitos

Antes de começar, certifique-se de ter instalado os seguintes itens:

- [Node.js](https://nodejs.org) (npm será instalado junto)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [FFmpeg](https://ffmpeg.org/)

## Instalação

1. Clone o repositório:

```bash
git clone https://github.com/coradini1/MediaHarvest.git
```

2. Instale as dependências do projeto:

```bash
cd MediaHarvest
npm install
```

3. Verifique se o yt-dlp está instalado corretamente:

```bash
yt-dlp --version
```

4. Certifique-se de que o FFmpeg está instalado corretamente:

```bash
ffmpeg -version
```

5. Defina as variáveis de ambiente necessárias. Você pode fazer isso manualmente ou usando um arquivo `.env`. Consulte a seção "Variáveis de Ambiente" para obter mais informações.

## Uso

Para iniciar o backend e permitir o download de vídeos, execute os seguintes comandos:

```bash
cd backend
node server.js
```

O backend estará em execução e pronto para aceitar solicitações de download de vídeos.

Se desejar baixar vídeos de outros sites além dos suportados por padrão, consulte o repositório oficial do yt-dlp para verificar se o site é suportado e faça as alterações necessárias no código.

## Variáveis de Ambiente

As seguintes variáveis de ambiente devem ser definidas:

- `PORT`: Porta em que o servidor backend será executado (padrão: 3000).
- `YT_DLP_PATH`: Caminho para o executável do yt-dlp.
- `FFMPEG_PATH`: Caminho para o executável do FFmpeg.

Certifique-se de definir essas variáveis antes de iniciar o servidor backend.


## Licença

Este projeto é licenciado sob a Licença MIT - consulte o arquivo [LICENSE](LICENSE) para obter mais detalhes.
```
