'use strict';

class Receiver {
    constructor(service) {
        this.amqpChannel = undefined;

        global.logger.info('Starting ' + service.getServiceName());

        global.etcd3.put('/aurora/services/' + service.getServiceName() + '/hash').value(service.getServiceHash()).exec();

        global.amqpConnection.createChannel().then((channel) => {
            this.amqpChannel = channel;
            return Promise.resolve(channel);
        }).then((channel) => {
            return channel.assertExchange('battlenet_aurora_bus', 'direct');
        }).then(() => {
            return this.amqpChannel.assertQueue('', {autoDelete: true});
        }).then((result) => {
            this.amqpChannel.bindQueue(result.queue, 'battlenet_aurora_bus', service.getServiceHash().toString());
            return Promise.resolve(result.queue);
        }).then((queueName) => {
            global.logger.info(service.getServiceName()+' listening');
            this.amqpChannel.consume(queueName, (message) => {
                let context = {
                    queueName: message.properties.replyTo,
                    header: message.properties.headers,
                    request: null,
                    response: null
                };

                service.handleCall(context, message.content).then((buffer) => {
                    if (Buffer.isBuffer(buffer)) {
                        this.amqpChannel.sendToQueue(message.properties.replyTo, buffer,
                            {
                                appId: service.getServiceName(),
                                type: 'response'
                            });
                    }
                });

                this.amqpChannel.ack(message);
            });
        });
    }

    closeChannel() {
        return this.amqpChannel.close();
    }
}

module.exports = Receiver;