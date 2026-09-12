FROM node:25

ARG USER_NAME=etovaz
ARG USER_UID=1000
ARG USER_GID=1000

RUN apt update && \
    apt install -y zsh curl gnupg git nano build-essential wget lsb-release inotify-tools ca-certificates sudo

RUN (type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
	&& sudo mkdir -p -m 755 /etc/apt/keyrings \
	&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
	&& cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
	&& sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& sudo mkdir -p -m 755 /etc/apt/sources.list.d \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
	&& sudo apt update \
	&& sudo apt install gh -y

RUN rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    getent passwd "${USER_UID}" | cut -d: -f1 | grep -vx "${USER_NAME}" | xargs -r -I{} usermod -l "${USER_NAME}" -d "/home/${USER_NAME}" -m -s /usr/bin/zsh {}; \
    getent group  "${USER_GID}" | cut -d: -f1 | grep -vx "${USER_NAME}" | xargs -r -I{} groupmod -n "${USER_NAME}" {}; \
    getent group  "${USER_GID}" > /dev/null || groupadd --gid "${USER_GID}" "${USER_NAME}"; \
    id "${USER_NAME}" 2>/dev/null         || useradd --uid "${USER_UID}" --gid "${USER_GID}" --create-home --shell /usr/bin/zsh "${USER_NAME}"; \
    usermod --append --groups sudo "${USER_NAME}"; \
    printf '%s ALL=(ALL) NOPASSWD:ALL\n' "${USER_NAME}" > "/etc/sudoers.d/${USER_NAME}"; \
    chmod 0440 "/etc/sudoers.d/${USER_NAME}"; \
    chown -R "${USER_NAME}:${USER_NAME}" "/home/${USER_NAME}"

ENV MISE_INSTALL_PATH=/usr/local/bin/mise
RUN curl https://mise.jdx.dev/install.sh | sh

COPY ./scripts/start.sh /start/start.sh

ENV HOME=/home/${USER_NAME}

USER ${USER_NAME}


RUN RUNZSH=no sh -c "$(curl -fsSL https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" && \
    git clone --depth=1 https://github.com/romkatv/powerlevel10k.git ~/powerlevel10k && \
    git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions && \
    git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting && \
    git clone --depth 1 https://github.com/junegunn/fzf.git ~/.fzf && \
    ~/.fzf/install --all

RUN curl -fsSL https://claude.ai/install.sh | bash

COPY ./scripts/.zshrc /home/${USER_NAME}/.zshrc

WORKDIR /src

CMD ["/start/start.sh"]