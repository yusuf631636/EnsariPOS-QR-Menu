"use strict";

function test() {
    // create Object to hold config info
    var config = {};
    var storage = window.localStorage;
    // derive Server information from Address Bar
    if (storage.getItem("ip")) {
        var webHost = storage.getItem("ip");
    } else {
        var webHost = location.hostname; // myServer.com
    }
    var webPort = location.port; // blank assumes port 80
    var webPath = location.pathname; // might be like /app/mysite/blah
    var webParm = location.search; // things after '?', like ?module=customer_display
    var webProto = 'http:'; // usually http: or https:

    var webUrl = webProto + '//' + webHost + (location.port ? ':' + location.port : '') + webPath;

    // Message Server
    var msgsrv = webHost;

    // GraphQL server
    var GQLhost = msgsrv;
    var GQLport = '9000';
    var GQLpath = '/api/graphql/';
    var GQLserv = webProto + '//' + GQLhost + ':' + GQLport;
    var GQLurl = GQLserv + GQLpath;

    // SIGNALR server
    var SIGNALRhost = msgsrv;
    var SIGNALRport = GQLport;
    var SIGNALRpath = '/signalr';
    var SIGNALRhubs = '/signalr/hubs/';
    var SIGNALRserv = webProto + '//' + SIGNALRhost + ':' + SIGNALRport;
    console.log(SIGNALRserv);
    var SIGNALRurl = SIGNALRserv + SIGNALRpath;
    var SIGNALRhub = SIGNALRserv + SIGNALRhubs;

    // Terminal settings
    // assign some stuff to the Object
    // you can override the "auto config" here if you wish
    config.GQLserv = GQLserv;
    config.GQLurl = GQLurl;
    config.SIGNALRserv = SIGNALRserv;
    config.SIGNALRurl = SIGNALRurl;

    // the rest comes from Terminal settings (above)
    return config; // return the Object to the caller
}
var test = test();
function connect(callback) {
    var connection = $.hubConnection(test.SIGNALRserv);
    var proxy = connection.createHubProxy('default');

    // receives broadcast messages from a hub function, called "broadcastMessage"
    proxy.on('update', function (message) {
        if (callback) callback(message);
    });

    // atempt connection, and handle errors
    connection.start({ jsonp: true }).done(function () {
        console.log('Signalr now connected, connection ID=' + connection.id);
    }).fail(function () {
        console.log('Signalr could not connect');
    });
}