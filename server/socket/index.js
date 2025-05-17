const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const getUserDetailsFromToken = require('../helpers/getUserDetailsFromToken');
const UserModel = require('../models/UserModel');
const { ConversationModel, MessageModel } = require('../models/ConversationModel');
const getConversation = require('../helpers/getConversation');

const app = express();

/*** Socket server setup ***/
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL,
    credentials: true,
  },
});

// Online users
const onlineUser = new Set();

io.on('connection', async (socket) => {
  console.log('Connected User', socket.id);

  try {
    const token = socket.handshake.auth.token;

    // Validate and retrieve user details
    const user = await getUserDetailsFromToken(token);

    if (!user || !user._id) {
      console.error('Invalid token or user details.');
      socket.disconnect();
      return;
    }

    // Create a room for the user
    const userId = user._id.toString();
    socket.join(userId);
    onlineUser.add(userId);

    io.emit('onlineUser', Array.from(onlineUser));

    // Message-page event
    socket.on('message-page', async (userId) => {
      try {
        console.log('UserId:', userId);

        const userDetails = await UserModel.findById(userId).select('-password');

        const payload = {
          _id: userDetails?._id,
          name: userDetails?.name,
          email: userDetails?.email,
          profile_pic: userDetails?.profile_pic,
          online: onlineUser.has(userId),
        };

        socket.emit('message-user', payload);

        const getConversationMessage = await ConversationModel.findOne({
          $or: [
            { sender: user._id, receiver: userId },
            { sender: userId, receiver: user._id },
          ],
        })
          .populate('messages')
          .sort({ updatedAt: -1 });

        socket.emit('message', getConversationMessage?.messages || []);
      } catch (err) {
        console.error('Error handling message-page event:', err.message);
      }
    });

    // New message event
    socket.on('new message', async (data) => {
      try {
        let conversation = await ConversationModel.findOne({
          $or: [
            { sender: data?.sender, receiver: data?.receiver },
            { sender: data?.receiver, receiver: data?.sender },
          ],
        });

        if (!conversation) {
          const createConversation = new ConversationModel({
            sender: data?.sender,
            receiver: data?.receiver,
          });
          conversation = await createConversation.save();
        }

        const message = new MessageModel({
          text: data.text,
          imageUrl: data.imageUrl,
          videoUrl: data.videoUrl,
          msgByUserId: data?.msgByUserId,
        });

        const saveMessage = await message.save();

        await ConversationModel.updateOne(
          { _id: conversation?._id },
          { $push: { messages: saveMessage?._id } }
        );

        const getConversationMessage = await ConversationModel.findOne({
          $or: [
            { sender: data?.sender, receiver: data?.receiver },
            { sender: data?.receiver, receiver: data?.sender },
          ],
        })
          .populate('messages')
          .sort({ updatedAt: -1 });

        io.to(data?.sender).emit('message', getConversationMessage?.messages || []);
        io.to(data?.receiver).emit('message', getConversationMessage?.messages || []);

        const conversationSender = await getConversation(data?.sender);
        const conversationReceiver = await getConversation(data?.receiver);

        io.to(data?.sender).emit('conversation', conversationSender);
        io.to(data?.receiver).emit('conversation', conversationReceiver);
      } catch (err) {
        console.error('Error handling new message event:', err.message);
      }
    });

    // Sidebar event
    socket.on('sidebar', async (currentUserId) => {
      try {
        const conversation = await getConversation(currentUserId);
        socket.emit('conversation', conversation);
      } catch (err) {
        console.error('Error handling sidebar event:', err.message);
      }
    });

    // Seen event
    socket.on('seen', async (msgByUserId) => {
      try {
        const conversation = await ConversationModel.findOne({
          $or: [
            { sender: user?._id, receiver: msgByUserId },
            { sender: msgByUserId, receiver: user?._id },
          ],
        });

        const conversationMessageId = conversation?.messages || [];

        await MessageModel.updateMany(
          { _id: { $in: conversationMessageId }, msgByUserId: msgByUserId },
          { $set: { seen: true } }
        );

        const conversationSender = await getConversation(user?._id?.toString());
        const conversationReceiver = await getConversation(msgByUserId);

        io.to(user?._id?.toString()).emit('conversation', conversationSender);
        io.to(msgByUserId).emit('conversation', conversationReceiver);
      } catch (err) {
        console.error('Error handling seen event:', err.message);
      }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      onlineUser.delete(userId);
      console.log('Disconnected User', socket.id);
    });
  } catch (err) {
    console.error('Error during connection:', err.message);
  }
});

module.exports = {
  app,
  server,
};
