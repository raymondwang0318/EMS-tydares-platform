FROM nginx:alpine

RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/ems.conf
COPY www/ems /var/www/ems
COPY www/admin /var/www/admin
