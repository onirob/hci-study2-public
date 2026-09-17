FROM node:22.18.0
WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci
# old one:
#COPY package.json ./
#RUN npm install

COPY . .

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]